/**
 * ClawSats OpenClaw Plugin
 *
 * Registers first-class agent tools for discovering and hiring
 * ClawSats agents with BSV micropayments.
 *
 * Tools:
 *   clawsats_discover  — list all known Claws from the directory
 *   clawsats_call      — pay for and execute a capability on a remote Claw
 *
 * Config (openclaw.json):
 *   plugins.entries.clawsats.config.rootKeyHex    — BSV wallet private key
 *   plugins.entries.clawsats.config.directoryUrl  — directory API URL
 *
 * Or via env:
 *   CLAWSATS_ROOT_KEY_HEX
 *   CLAWSATS_DIRECTORY_URL
 */

const { execFile } = require('child_process');
const path = require('path');

const CLIENT_PATH = path.join(__dirname, '..', '..', 'skills', 'clawsats', 'client.js');

function runClient(args, env) {
  return new Promise((resolve, reject) => {
    execFile('node', [CLIENT_PATH, ...args], {
      env: { ...process.env, ...env },
      timeout: 60000,
      maxBuffer: 1024 * 1024
    }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout);
      }
    });
  });
}

function getEnv(api) {
  const cfg = api.config || {};
  const env = {};
  if (cfg.rootKeyHex) env.CLAWSATS_ROOT_KEY_HEX = cfg.rootKeyHex;
  if (cfg.directoryUrl) env.CLAWSATS_DIRECTORY_URL = cfg.directoryUrl;
  return env;
}

module.exports = function (api) {

  // ── clawsats_discover ──
  api.registerTool({
    name: 'clawsats_discover',
    description: 'List all known ClawSats agents from the directory. Returns identity keys, endpoints, capabilities, and status.',
    parameters: {
      type: 'object',
      properties: {},
      required: []
    },
    async execute(_id, _params) {
      try {
        const output = await runClient(['discover'], getEnv(api));
        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  });

  // ── clawsats_call ──
  api.registerTool({
    name: 'clawsats_call',
    description: 'Pay for and execute a capability on a remote ClawSats agent. Handles the full BSV 402 payment flow automatically. Requires CLAWSATS_ROOT_KEY_HEX to be set.',
    parameters: {
      type: 'object',
      properties: {
        endpoint: {
          type: 'string',
          description: 'The Claw endpoint URL, e.g. http://45.76.10.20:3321'
        },
        capability: {
          type: 'string',
          description: 'Capability name: echo, sign_message, hash_commit, timestamp_attest, fetch_url, dns_resolve, verify_receipt, peer_health_check, broadcast_listing'
        },
        params: {
          type: 'string',
          description: 'JSON string of parameters to pass to the capability'
        }
      },
      required: ['endpoint', 'capability']
    },
    async execute(_id, params) {
      try {
        const args = ['call', params.endpoint, params.capability];
        if (params.params) args.push(params.params);
        const output = await runClient(args, getEnv(api));
        return { content: [{ type: 'text', text: output }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Error: ${err.message}` }] };
      }
    }
  }, { optional: true });

};
