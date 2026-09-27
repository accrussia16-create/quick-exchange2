const express = require("express");
const session = require("express-session");
const fs = require("fs");
const path = require("path");

const app = express();

// Important for Railway / reverse proxies
app.set("trust proxy", 1);

const PORT = process.env.PORT || 3000;

const DB_DIR = path.join(__dirname, "data");
const DB_FILE = path.join(DB_DIR, "db.json");

const ADMIN_USER = process.env.ADMIN_USER || "admin";
const ADMIN_PASS = process.env.ADMIN_PASS || "change-me";
const SESSION_SECRET =
  process.env.SESSION_SECRET || "dev-secret-change-me";

// =====================================================
// DEFAULT DATABASE
// =====================================================

const DEFAULT_DB = {
  settings: {
    site
