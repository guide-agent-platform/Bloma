/**
 * 数据持久化帮助函数（real-fullstack 骨架，业务路由直接 require 使用）。
 *
 * 语义与平台旧路径 ctx.readData/ctx.writeData 对齐：数据落项目 data/ 目录
 * （data/<name>.json），原子写（临时文件 + rename），重启不丢。
 * 改数据结构时按 server/routes/_migrate.example.js 约定补迁移，禁弃旧数据。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');

function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/** 读整档数据；文件不存在/损坏时返回 fallback（不抛错，空态合法）。 */
function readData(name, fallback) {
  const file = path.join(DATA_DIR, `${name}.json`);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 原子写整档数据：先写 <name>.json.tmp 再 rename，避免半截文件。 */
function writeData(name, value) {
  ensureDataDir();
  const file = path.join(DATA_DIR, `${name}.json`);
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { readData, writeData, DATA_DIR };
