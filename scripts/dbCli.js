'use strict';

const path = require('path');
const { spawn } = require('child_process');

function databaseConfig() {
    const config = {
        host: process.env.DB_HOST,
        user: process.env.DB_USER,
        password: process.env.DB_PASSWORD,
        database: process.env.DB_NAME,
        port: process.env.DB_PORT
    };
    const missing = ['host', 'user', 'database'].filter((key) => !config[key]);
    if (missing.length) {
        throw new Error(`Missing database setting(s): ${missing.map((key) => `DB_${key.toUpperCase()}`).join(', ')}.`);
    }
    return config;
}

function cliArgs(config) {
    const args = [
        `--host=${config.host}`,
        `--user=${config.user}`,
        '--default-character-set=utf8mb4'
    ];
    if (config.port) args.push(`--port=${config.port}`);
    return args;
}

function startCli(command, args, config, stdio) {
    return spawn(command, args, {
        stdio,
        windowsHide: true,
        env: {
            ...process.env,
            ...(config.password ? { MYSQL_PWD: config.password } : {})
        }
    });
}

function captureStderr(child) {
    let output = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
        output = (output + chunk).slice(-12000);
    });
    return () => output.trim();
}

function waitForExit(child, getStderr, command) {
    return new Promise((resolve, reject) => {
        child.once('error', (error) => {
            reject(new Error(`Could not start ${command}: ${error.message}`));
        });
        child.once('close', (code, signal) => {
            if (code === 0) return resolve();
            const detail = getStderr();
            reject(new Error(
                `${command} exited ${signal ? `after ${signal}` : `with code ${code}`}` +
                (detail ? `: ${detail}` : '.')
            ));
        });
    });
}

function resolveBackupDirectory(argument) {
    return path.resolve(argument || process.env.DB_BACKUP_DIR || path.join(__dirname, '..', 'backups'));
}

module.exports = { databaseConfig, cliArgs, startCli, captureStderr, waitForExit, resolveBackupDirectory };
