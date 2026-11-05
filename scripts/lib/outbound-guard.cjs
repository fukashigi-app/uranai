/**
 * E2E 用：アプリのサーバーの外向きの通信を止める（node --require で読み込む。本番・Vercel では使わない）。
 *  - fetch：localhost 以外への通信はすべて失敗させる。discord.com / discordapp.com への通信は送らずに記録し、模擬の応答を返す
 *    （応答の状態は OUTBOUND_GUARD_DISCORD_STATUS_FILE の中身の数値。無ければ 204。OUTBOUND_GUARD_DISCORD_DELAY_MS で応答を遅らせる）
 *  - http / https モジュール：localhost 以外への接続を失敗させる（Stripe SDK・Google の認証などが外に出ないように）
 * 記録（OUTBOUND_GUARD_LOG）には送信先のホスト・パスの形・本文だけを書く。トークンの部分は伏せる。
 */
"use strict";
/* eslint-disable @typescript-eslint/no-require-imports -- node --require で読み込む CommonJS のため */
const fs = require("node:fs");
const http = require("node:http");
const https = require("node:https");

const LOCAL = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const DISCORD = new Set(["discord.com", "discordapp.com"]);
const LOG = process.env.OUTBOUND_GUARD_LOG || "";
const STATUS_FILE = process.env.OUTBOUND_GUARD_DISCORD_STATUS_FILE || "";
const DELAY_MS = Number(process.env.OUTBOUND_GUARD_DISCORD_DELAY_MS || 0);

function record(entry) {
  if (LOG) fs.appendFileSync(LOG, JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
}
function hostOf(input) {
  try {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    return { host: u.hostname, url: u };
  } catch {
    return { host: "", url: null };
  }
}

const realFetch = globalThis.fetch;
globalThis.fetch = async function guardedFetch(input, init) {
  const { host, url } = hostOf(input);
  if (LOCAL.has(host)) return realFetch(input, init);
  if (DISCORD.has(host)) {
    let status = 204;
    try {
      status = Number(fs.readFileSync(STATUS_FILE, "utf8").trim()) || 204;
    } catch {}
    const body = init && typeof init.body === "string" ? init.body : null;
    record({ kind: "discord", host, path: url.pathname.replace(/\/[^/]+$/, "/<token>"), method: init && init.method, redirect: init && init.redirect, body, status });
    if (DELAY_MS > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
    return new Response(null, { status });
  }
  record({ kind: "blocked_fetch", host });
  throw new TypeError(`outbound-guard: blocked fetch to ${host}`);
};

function guardModule(mod, name) {
  for (const fn of ["request", "get"]) {
    const real = mod[fn];
    mod[fn] = function guarded(...args) {
      const a = args[0];
      let host = "";
      if (typeof a === "string" || a instanceof URL) host = hostOf(a).host;
      else if (a && typeof a === "object") host = String(a.hostname || a.host || "localhost").replace(/:\d+$/, "");
      if (!LOCAL.has(host)) {
        record({ kind: `blocked_${name}`, host });
        throw new Error(`outbound-guard: blocked ${name} to ${host}`);
      }
      return real.apply(this, args);
    };
  }
}
guardModule(http, "http");
guardModule(https, "https");
