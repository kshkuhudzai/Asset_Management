'use strict';

const mysql = require('mysql2/promise');
require('dotenv').config();

// Create a connection pool for better performance under load
const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 100,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0
});

// Test the connection immediately when the server starts
pool.getConnection()
    .then(connection => {
        console.log('✅ Successfully connected to the MySQL database:', process.env.DB_NAME);
        connection.release();
    })
    .catch(err => {
        console.error('❌ Database connection failed:', err.message);
        process.exit(1); // Exit the process if we can't connect to the DB
    });

module.exports = pool;