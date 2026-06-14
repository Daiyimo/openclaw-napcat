const fs = require('fs');
const path = process.argv[2];
if (!path) { console.error('Usage: fix-config.cjs <config.json>'); process.exit(1); }
const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
let changed = false;
const validProfiles = ['minimal', 'coding', 'messaging', 'full'];
const profile = cfg.tools && cfg.tools.profile;

if (typeof profile === 'object' && profile !== null) {
    cfg.tools = cfg.tools || {};
    cfg.tools.profile = 'full';
    changed = true;
    console.log('FIXED: tools.profile was invalid object, set to full');
} else if (typeof profile === 'string' && !validProfiles.includes(profile)) {
    cfg.tools = cfg.tools || {};
    cfg.tools.profile = 'full';
    changed = true;
    console.log('FIXED: tools.profile was invalid value, set to full');
}

if (!cfg.tools) cfg.tools = {};
if (!cfg.tools.sessions) cfg.tools.sessions = {};
if (cfg.tools.sessions.visibility !== 'all') {
    cfg.tools.sessions.visibility = 'all';
    changed = true;
    console.log('FIXED: tools.sessions.visibility = all');
}
if (!cfg.tools.agentToAgent) cfg.tools.agentToAgent = {};
if (cfg.tools.agentToAgent.enabled !== true) {
    cfg.tools.agentToAgent.enabled = true;
    changed = true;
    console.log('FIXED: tools.agentToAgent.enabled = true');
}

// Disable memory-core plugin (not needed for most users)
if (!cfg.plugins) cfg.plugins = {};
if (!cfg.plugins.entries) cfg.plugins.entries = {};
if (!cfg.plugins.entries['memory-core']) cfg.plugins.entries['memory-core'] = {};
if (cfg.plugins.entries['memory-core'].enabled !== false) {
    cfg.plugins.entries['memory-core'] = { enabled: false };
    changed = true;
    console.log('FIXED: plugins.entries.memory-core.enabled = false');
}

if (changed) {
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    console.log('__CHANGED__');
} else {
    console.log('__SKIP__');
}
