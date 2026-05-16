import logger from './logger.js';

function normalizeIp(ip) {
    if (!ip || typeof ip !== 'string') return '';

    let value = ip.trim();
    if (!value) return '';

    if (value.startsWith('::ffff:')) {
        value = value.slice('::ffff:'.length);
    }

    if (value.startsWith('[') && value.includes(']')) {
        value = value.slice(1, value.indexOf(']'));
    }

    return value.toLowerCase();
}

function getBindingClientIps(binding) {
    const ips = [];
    for (const key of ['clientIp', 'clientIP', 'ip']) {
        if (typeof binding?.[key] === 'string') ips.push(binding[key]);
    }
    for (const key of ['clientIps', 'clientIPs', 'ips']) {
        if (Array.isArray(binding?.[key])) ips.push(...binding[key].filter(ip => typeof ip === 'string'));
    }
    return ips.map(normalizeIp).filter(Boolean);
}

function normalizeBinding(rawBinding) {
    if (!rawBinding || typeof rawBinding !== 'object') return null;
    if (rawBinding.enabled === false) return null;

    const clientIps = getBindingClientIps(rawBinding);
    const providerType = typeof rawBinding.providerType === 'string' ? rawBinding.providerType.trim() : '';
    const uuid = typeof rawBinding.uuid === 'string'
        ? rawBinding.uuid.trim()
        : (typeof rawBinding.nodeUuid === 'string' ? rawBinding.nodeUuid.trim() : '');

    if (clientIps.length === 0 || !providerType || !uuid) {
        return null;
    }

    const proxyUrl = typeof rawBinding.proxyUrl === 'string' && rawBinding.proxyUrl.trim()
        ? rawBinding.proxyUrl.trim()
        : null;

    return {
        clientIps,
        providerType,
        uuid,
        proxyUrl,
        tlsSidecar: rawBinding.tlsSidecar === true,
        strict: rawBinding.strict !== false,
        raw: rawBinding
    };
}

export function normalizeIpNodeProxyBindings(bindings) {
    if (!Array.isArray(bindings)) return [];
    return bindings.map(normalizeBinding).filter(Boolean);
}

export function hasTLSSidecarBindings(config) {
    if (normalizeIpNodeProxyBindings(config?.IP_NODE_PROXY_BINDINGS).some(binding => binding.tlsSidecar)) {
        return true;
    }

    const providerPools = config?.providerPools;
    if (!providerPools || typeof providerPools !== 'object') return false;

    return Object.values(providerPools).some(pool =>
        Array.isArray(pool) && pool.some(node => node?.tlsSidecar === true)
    );
}

export function createIpNodeProxyBinding(config, clientIp) {
    const normalizedClientIp = normalizeIp(clientIp);
    const bindings = normalizeIpNodeProxyBindings(config?.IP_NODE_PROXY_BINDINGS)
        .filter(binding => binding.clientIps.includes(normalizedClientIp));

    if (bindings.length === 0) return null;

    const byProvider = new Map();
    for (const binding of bindings) {
        if (!byProvider.has(binding.providerType)) {
            byProvider.set(binding.providerType, binding);
        }
    }

    logger.info(`[IP Node Binding] Matched ${bindings.length} binding(s) for client IP ${clientIp}`);

    return {
        clientIp: normalizedClientIp || clientIp,
        getPreferredNode(providerType) {
            return byProvider.get(providerType)?.uuid || null;
        },
        hasBinding(providerType) {
            return byProvider.has(providerType);
        },
        isStrict(providerType) {
            const binding = byProvider.get(providerType);
            return binding ? binding.strict : false;
        },
        getProxyUrl(providerType, uuid) {
            const binding = byProvider.get(providerType);
            if (!binding || binding.uuid !== uuid) return null;
            return binding.proxyUrl || null;
        },
        isTLSSidecarEnabled(providerType, uuid) {
            const binding = byProvider.get(providerType);
            return Boolean(binding && binding.uuid === uuid && binding.tlsSidecar);
        },
        getBinding(providerType) {
            const binding = byProvider.get(providerType);
            return binding ? { ...binding, raw: undefined } : null;
        }
    };
}

export { normalizeIp };
