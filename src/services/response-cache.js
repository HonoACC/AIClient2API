import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import logger from '../utils/logger.js';

const CACHE_VERSION = 1;
const DEFAULT_TTL_SECONDS = 300;
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_TEMPERATURE_MAX = 0.2;
const DEFAULT_SCOPE = 'api-key';

function getCacheConfig(config = {}) {
    return {
        enabled: config.RESPONSE_CACHE_ENABLED === true,
        dir: config.RESPONSE_CACHE_DIR || 'configs/response-cache',
        ttlSeconds: Number(config.RESPONSE_CACHE_TTL_SECONDS) > 0
            ? Number(config.RESPONSE_CACHE_TTL_SECONDS)
            : DEFAULT_TTL_SECONDS,
        maxBodyBytes: Number(config.RESPONSE_CACHE_MAX_BODY_BYTES) > 0
            ? Number(config.RESPONSE_CACHE_MAX_BODY_BYTES)
            : DEFAULT_MAX_BODY_BYTES,
        maxStreamBytes: Number(config.RESPONSE_CACHE_MAX_STREAM_BYTES) > 0
            ? Number(config.RESPONSE_CACHE_MAX_STREAM_BYTES)
            : DEFAULT_MAX_BODY_BYTES,
        temperatureMax: Number(config.RESPONSE_CACHE_TEMPERATURE_MAX) >= 0
            ? Number(config.RESPONSE_CACHE_TEMPERATURE_MAX)
            : DEFAULT_TEMPERATURE_MAX,
        scope: config.RESPONSE_CACHE_SCOPE || DEFAULT_SCOPE,
        allowUnary: config.RESPONSE_CACHE_ALLOW_UNARY !== false,
        allowStream: config.RESPONSE_CACHE_ALLOW_STREAM !== false,
        streamReplayDelayMs: Math.max(0, Number(config.RESPONSE_CACHE_STREAM_REPLAY_DELAY_MS) || 0)
    };
}

function hashText(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function stableStringify(value) {
    if (value === null || typeof value !== 'object') {
        return JSON.stringify(value);
    }

    if (Array.isArray(value)) {
        return `[${value.map(stableStringify).join(',')}]`;
    }

    return `{${Object.keys(value).sort().map(key =>
        `${JSON.stringify(key)}:${stableStringify(value[key])}`
    ).join(',')}}`;
}

function extractApiKey(req) {
    const authHeader = req?.headers?.authorization;
    if (authHeader?.startsWith('Bearer ')) {
        return authHeader.substring(7);
    }
    return req?.headers?.['x-api-key'] ||
        req?.headers?.['x-goog-api-key'] ||
        null;
}

function getRequestScope(req, config, cacheConfig) {
    if (cacheConfig.scope === 'global') {
        return 'global';
    }

    const apiKey = extractApiKey(req);
    if (apiKey) {
        return `api-key:${hashText(apiKey).slice(0, 24)}`;
    }

    return `config-key:${hashText(config?.REQUIRED_API_KEY || '').slice(0, 24)}`;
}

function hasToolUse(body = {}) {
    return Boolean(
        body.tools ||
        body.tool_choice ||
        body.functions ||
        body.function_call
    );
}

function containsNonTextPart(value) {
    if (!value || typeof value !== 'object') {
        return false;
    }

    if (Array.isArray(value)) {
        return value.some(containsNonTextPart);
    }

    if (
        value.image_url ||
        value.inline_data ||
        value.file_data ||
        value.input_audio ||
        value.audio ||
        value.video ||
        value.document
    ) {
        return true;
    }

    if (typeof value.type === 'string') {
        const type = value.type.toLowerCase();
        if (type.includes('image') || type.includes('audio') || type.includes('video') || type.includes('file')) {
            return true;
        }
    }

    return Object.values(value).some(containsNonTextPart);
}

function getNumericSetting(body, names) {
    for (const name of names) {
        if (body?.[name] !== undefined) {
            const value = Number(body[name]);
            return Number.isFinite(value) ? value : null;
        }
    }
    return null;
}

function getCacheFilePath(config, key) {
    const cacheConfig = getCacheConfig(config);
    const baseDir = path.isAbsolute(cacheConfig.dir)
        ? cacheConfig.dir
        : path.join(process.cwd(), cacheConfig.dir);
    return path.join(baseDir, key.slice(0, 2), `${key}.json`);
}

function isCacheableRequest({ req, config, requestBody, isStream, fromProvider, endpointType, model, requestPath }) {
    const cacheConfig = getCacheConfig(config);
    if (!cacheConfig.enabled) {
        return { cacheable: false, reason: 'disabled' };
    }
    if (isStream && !cacheConfig.allowStream) {
        return { cacheable: false, reason: 'stream-disabled' };
    }
    if (!isStream && !cacheConfig.allowUnary) {
        return { cacheable: false, reason: 'unary-disabled' };
    }
    if (req?.method && req.method !== 'POST') {
        return { cacheable: false, reason: 'method' };
    }
    if (req?.headers?.['cache-control']?.includes('no-store')) {
        return { cacheable: false, reason: 'no-store' };
    }
    if (!model) {
        return { cacheable: false, reason: 'missing-model' };
    }
    if (hasToolUse(requestBody)) {
        return { cacheable: false, reason: 'tools' };
    }
    if (containsNonTextPart(requestBody)) {
        return { cacheable: false, reason: 'non-text' };
    }

    const temperature = getNumericSetting(requestBody, ['temperature']);
    if (temperature !== null && temperature > cacheConfig.temperatureMax) {
        return { cacheable: false, reason: 'temperature' };
    }

    const bodyBytes = Buffer.byteLength(stableStringify(requestBody || {}));
    if (bodyBytes > cacheConfig.maxBodyBytes) {
        return { cacheable: false, reason: 'body-too-large' };
    }

    const keyPayload = {
        version: CACHE_VERSION,
        scope: getRequestScope(req, config, cacheConfig),
        endpointType,
        fromProvider,
        requestPath,
        model,
        isStream: Boolean(isStream),
        requestBody,
        systemPromptMode: config?.SYSTEM_PROMPT_MODE || null,
        systemPromptHash: hashText(config?.SYSTEM_PROMPT_CONTENT || ''),
        replacementsHash: hashText(stableStringify(config?.SYSTEM_PROMPT_REPLACEMENTS || [])),
        customModelsHash: hashText(stableStringify(config?.customModels || []))
    };

    return {
        cacheable: true,
        key: hashText(stableStringify(keyPayload)),
        cacheConfig
    };
}

export function createResponseCacheDecision(context) {
    return isCacheableRequest(context);
}

export async function readResponseCache(config, decision, expectedType) {
    if (!decision?.cacheable || !decision.key) {
        return null;
    }

    try {
        const filePath = getCacheFilePath(config, decision.key);
        const content = await fs.readFile(filePath, 'utf8');
        const entry = JSON.parse(content);
        if (!entry || entry.key !== decision.key || entry.type !== expectedType) {
            return null;
        }
        if (entry.expiresAt && Date.parse(entry.expiresAt) <= Date.now()) {
            await fs.unlink(filePath).catch(() => {});
            return null;
        }
        return entry;
    } catch (error) {
        if (error.code !== 'ENOENT') {
            logger.warn(`[Response Cache] Failed to read cache: ${error.message}`);
        }
        return null;
    }
}

export async function saveResponseCache(config, decision, entry) {
    if (!decision?.cacheable || !decision.key || !entry) {
        return false;
    }

    const cacheConfig = decision.cacheConfig || getCacheConfig(config);
    const maxBytes = entry.type === 'stream' ? cacheConfig.maxStreamBytes : cacheConfig.maxBodyBytes;
    const bodyBytes = Buffer.byteLength(JSON.stringify(entry));
    if (bodyBytes > maxBytes) {
        logger.info(`[Response Cache] Skipped oversized ${entry.type} entry (${bodyBytes} bytes)`);
        return false;
    }

    const finalEntry = {
        ...entry,
        key: decision.key,
        version: CACHE_VERSION,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + cacheConfig.ttlSeconds * 1000).toISOString()
    };

    try {
        const filePath = getCacheFilePath(config, decision.key);
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, JSON.stringify(finalEntry), { encoding: 'utf8', mode: 0o600 });
        logger.info(`[Response Cache] Stored ${entry.type} response: ${decision.key.slice(0, 12)}`);
        return true;
    } catch (error) {
        logger.warn(`[Response Cache] Failed to save cache: ${error.message}`);
        return false;
    }
}

export async function writeCachedUnaryResponse(res, entry) {
    res.writeHead(entry.statusCode || 200, {
        'Content-Type': entry.contentType || 'application/json',
        'X-A2-Cache': 'HIT'
    });
    res.end(entry.body);
}

export async function writeCachedStreamResponse(res, entry, config) {
    const cacheConfig = getCacheConfig(config);
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Transfer-Encoding': 'chunked',
        'X-A2-Cache': 'HIT'
    });

    for (const chunk of entry.chunks || []) {
        if (res.writableEnded || res.destroyed) {
            return;
        }
        res.write(chunk);
        if (cacheConfig.streamReplayDelayMs > 0) {
            await new Promise(resolve => setTimeout(resolve, cacheConfig.streamReplayDelayMs));
        }
    }
    res.end();
}

export function createStreamCacheRecorder(config, decision) {
    if (!decision?.cacheable || !decision.key) {
        return null;
    }

    const cacheConfig = decision.cacheConfig || getCacheConfig(config);
    const chunks = [];
    let bytes = 0;
    let overflow = false;

    return {
        record(chunk) {
            if (overflow || typeof chunk !== 'string') {
                return;
            }
            bytes += Buffer.byteLength(chunk);
            if (bytes > cacheConfig.maxStreamBytes) {
                overflow = true;
                chunks.length = 0;
                return;
            }
            chunks.push(chunk);
        },
        toEntry(metadata = {}) {
            if (overflow || chunks.length === 0) {
                return null;
            }
            return {
                type: 'stream',
                chunks,
                metadata
            };
        }
    };
}
