'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createGunzip } = require('zlib');
const { pipeline } = require('stream/promises');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');
const {
    databaseConfig,
    cliArgs,
    startCli,
    captureStderr,
    waitForExit
} = require('./dbCli');

async function confirmRestore(database) {
    if (process.argv.includes('--yes')) return;
    if (!stdin.isTTY || !stdout.isTTY) {
        throw new Error('Restore requires an interactive confirmation. Use --yes only when the target database is verified.');
    }
    const prompt = readline.createInterface({ input: stdin, output: stdout });
    try {
        const answer = await prompt.question(
            `This replaces data in database "${database}". Type the database name to continue: `
        );
        if (answer !== database) throw new Error('Database name did not match; restore cancelled.');
    } finally {
        prompt.close();
    }
}

async function restore() {
    const filename = process.argv.slice(2).find((argument) => argument !== '--yes');
    if (!filename) throw new Error('Usage: node scripts/restoreDb.js <backup.sql[.gz]> [--yes]');

    const backupPath = path.resolve(filename);
    const stat = await fs.promises.stat(backupPath);
    if (!stat.isFile()) throw new Error('The backup path must be a file.');

    const compressed = backupPath.toLowerCase().endsWith('.gz');
    if (!compressed && !backupPath.toLowerCase().endsWith('.sql')) {
        throw new Error('The backup file must end in .sql or .sql.gz.');
    }

    const config = databaseConfig();
    await confirmRestore(config.database);

    const command = process.env.MYSQL_PATH || 'mysql';
    const child = startCli(
        command,
        [...cliArgs(config), config.database],
        config,
        ['pipe', 'ignore', 'pipe']
    );
    const getStderr = captureStderr(child);
    const processExit = waitForExit(child, getStderr, command);
    const source = fs.createReadStream(backupPath);

    try {
        if (compressed) {
            await Promise.all([pipeline(source, createGunzip(), child.stdin), processExit]);
        } else {
            await Promise.all([pipeline(source, child.stdin), processExit]);
        }
        console.log(`Database restored from: ${backupPath}`);
    } catch (error) {
        if (!child.killed) child.kill();
        throw error;
    }
}

restore().catch((error) => {
    console.error(`Database restore failed: ${error.message}`);
    process.exitCode = 1;
});
