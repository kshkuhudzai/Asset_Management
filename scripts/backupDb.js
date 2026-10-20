'use strict';

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { createGzip } = require('zlib');
const { pipeline } = require('stream/promises');
const {
    databaseConfig,
    cliArgs,
    startCli,
    captureStderr,
    waitForExit,
    resolveBackupDirectory
} = require('./dbCli');

async function backup() {
    const config = databaseConfig();
    const directory = resolveBackupDirectory(process.argv[2]);
    await fs.promises.mkdir(directory, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${config.database}_${stamp}.sql.gz`;
    const destination = path.join(directory, filename);
    const temporary = `${destination}.partial-${process.pid}`;
    const command = process.env.MYSQLDUMP_PATH || 'mysqldump';
    const child = startCli(
        command,
        [
            ...cliArgs(config),
            '--single-transaction',
            '--routines',
            '--triggers',
            '--events',
            '--hex-blob',
            config.database
        ],
        config,
        ['ignore', 'pipe', 'pipe']
    );
    const getStderr = captureStderr(child);
    const processExit = waitForExit(child, getStderr, command);

    try {
        await Promise.all([
            pipeline(child.stdout, createGzip(), fs.createWriteStream(temporary, { flags: 'wx' })),
            processExit
        ]);
        await fs.promises.rename(temporary, destination);
        console.log(`Database backup created: ${destination}`);
    } catch (error) {
        if (!child.killed) child.kill();
        try {
            await fs.promises.rm(temporary, { force: true });
        } catch (cleanupError) {
            console.error(`Could not remove incomplete backup ${temporary}: ${cleanupError.message}`);
        }
        throw error;
    }
}

backup().catch((error) => {
    console.error(`Database backup failed: ${error.message}`);
    process.exitCode = 1;
});
