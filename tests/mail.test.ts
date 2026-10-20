import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "sl-mail-"));
process.env.LOG_LEVEL = "error";
process.env.MASTER_KEY = "ab".repeat(32);
const { getMailConfig, mergeMailConfig, saveMailConfig, sendMail } = await import("../src/lib/server/mail.ts");
const { raiseAlert, sendDigest } = await import("../src/lib/server/alert.ts");

/** Just enough SMTP to accept mail: records the login and every message. */
const inbox: { auth: string; data: string }[] = [];
const server = net.createServer((sock) => {
  let auth = "";
  let data: string | null = null;
  let buf = "";
  sock.write("220 test ESMTP\r\n");
  sock.on("data", (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf("\r\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (data != null) {
        if (line === ".") {
          inbox.push({ auth, data });
          data = null;
          sock.write("250 queued\r\n");
        } else data += line + "\n";
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === "EHLO") sock.write("250-test\r\n250 AUTH PLAIN\r\n");
      else if (cmd === "AUTH") {
        auth = Buffer.from(line.split(" ")[2], "base64").toString();
        sock.write(auth.endsWith("\0right-code") ? "235 ok\r\n" : "535 bad\r\n");
      } else if (cmd === "DATA") {
        data = "";
        sock.write("354 go\r\n");
      } else if (cmd === "QUIT") sock.end("221 bye\r\n");
      else sock.write("250 ok\r\n");
    }
  });
});
await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
const port = (server.address() as net.AddressInfo).port;
test.after(() => server.close());

/** Decoded text body of a received message (nodemailer sends UTF-8 as quoted-printable or base64). */
function body(raw: string): string {
  const [head, ...rest] = raw.split("\n\n");
  const text = rest.join("\n\n");
  if (/Content-Transfer-Encoding: base64/i.test(head)) return Buffer.from(text.replace(/\s+/g, ""), "base64").toString();
  if (/Content-Transfer-Encoding: quoted-printable/i.test(head)) {
    const bytes = text.replace(/=\n/g, "").replace(/\n/g, "\r\n");
    return Buffer.from(bytes.replace(/=([0-9A-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))), "latin1").toString("utf8");
  }
  return text;
}

const form = { host: "127.0.0.1", port, security: "none" as const, user: "bot@example.com", pass: "right-code", to: "a@example.com\nb@example.com" };
const until = async (cond: () => boolean) => {
  for (let k = 0; k < 100 && !cond(); k++) await new Promise((r) => setTimeout(r, 20));
};

test("mail config: validated, the password is kept when left blank, alerts need a complete setup", () => {
  assert.throws(() => mergeMailConfig({ ...form, to: "not-an-address" }), /收件邮箱格式不正确/);
  assert.throws(() => mergeMailConfig({ host: "smtp.qq.com", alertsEnabled: true }), /开启告警前/);
  const saved = saveMailConfig(form);
  assert.deepEqual(saved.to, ["a@example.com", "b@example.com"]);
  assert.ok(saved.passEnc && !saved.passEnc.includes("right-code"), "stored encrypted");
  const again = saveMailConfig({ ...form, pass: "" });
  assert.equal(again.passEnc, saved.passEnc);
});

test("mail: sends through SMTP with the stored code; a wrong code reads as a login problem", async () => {
  await sendMail("测试邮件", "你好");
  assert.equal(inbox.length, 1);
  assert.match(inbox[0].auth, /bot@example\.com\0right-code$/);
  assert.match(inbox[0].data, /Subject: =\?UTF-8\?/);
  await assert.rejects(sendMail("x", "y", mergeMailConfig({ pass: "wrong" })), /授权码/);
});

test("alerts: one mail per kind in 30 minutes, repeats counted into the next; daily digest", async () => {
  inbox.length = 0;
  saveMailConfig({ alertsEnabled: true });
  const t = Date.now();
  assert.equal(raiseAlert("datasource", "所有数据源都失败", { 币种: "BTC" }, t), true);
  assert.equal(raiseAlert("datasource", "所有数据源都失败", {}, t + 60_000), false);
  assert.equal(raiseAlert("datasource", "所有数据源都失败", {}, t + 120_000), false);
  assert.equal(raiseAlert("gap", "本地 K 线出现缺口", {}, t + 130_000), true, "another kind is not held back");
  assert.equal(raiseAlert("datasource", "主数据源不可用", {}, t + 31 * 60_000), true);
  await until(() => inbox.length >= 3);
  assert.equal(inbox.length, 3);
  const bodies = inbox.map((m) => body(m.data));
  // mails go out concurrently, so in any order
  assert.ok(bodies.some((b) => b.includes("所有数据源都失败") && b.includes("币种：BTC")));
  assert.ok(bodies.some((b) => b.includes("主数据源不可用") && b.includes("又出现了 2 次")), "the next mail says how many were held back");

  inbox.length = 0;
  assert.equal(await sendDigest(["数据库 40 MB"], t + 32 * 60_000), true);
  assert.equal(inbox.length, 1);
  // repeats of the same problem collapse into one line: 2 datasource lines and 1 gap line
  const digest = body(inbox[0].data);
  assert.ok(digest.includes("共 3 条告警"), digest);
  assert.ok(digest.includes("【数据源】2 条") && digest.includes("【K 线缺口】1 条") && digest.includes("数据库 40 MB"));

  saveMailConfig({ alertsEnabled: false });
  assert.equal(raiseAlert("db", "数据库接近上限"), false, "nothing is sent while alerts are off");
  assert.equal(getMailConfig().alertsEnabled, false);
});
