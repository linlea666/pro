/**
 * Server-side maintenance CLI (run through the `signallight` wrapper):
 *   migrate                       apply database migrations
 *   admin [--user NAME] [--password PASS]
 *                                 create or reset an admin; prints a generated password if none given
 *   backup [--label NAME]         back up the database now
 *   restore FILE                  replace the database with a backup (service must be stopped)
 *   info                          print database path, schema version, admin count
 */
import fs from "node:fs";
import { randomBytes } from "node:crypto";
import { dbPath, getDb, migrate, SCHEMA_VERSION } from "../src/lib/server/db.ts";
import { adminCount, upsertAdmin, validatePassword } from "../src/lib/server/auth.ts";
import { backupNow } from "../src/lib/server/jobs.ts";

const [cmd, ...rest] = process.argv.slice(2);
const opt = (name: string) => {
  const i = rest.indexOf(`--${name}`);
  return i >= 0 ? rest[i + 1] : undefined;
};

function genPassword() {
  // letters + digits, always passes validatePassword
  const base = randomBytes(12).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 12);
  return `${base}${(randomBytes(1)[0] % 90) + 10}a`;
}

async function main() {
  switch (cmd) {
    case "migrate": {
      const d = getDb(); // getDb() migrates on open
      const r = migrate(d);
      console.log(`数据库结构已是最新：v${r.to}（${dbPath()}）`);
      break;
    }
    case "admin": {
      const user = opt("user") || "admin";
      const given = opt("password");
      const password = given || genPassword();
      const bad = validatePassword(password);
      if (bad) throw new Error(bad);
      upsertAdmin(user, password);
      console.log(`管理员已就绪：用户名 ${user}`);
      if (!given) console.log(`初始密码：${password}  （登录后请到“系统设置”修改）`);
      break;
    }
    case "backup": {
      const file = await backupNow(opt("label") || "manual");
      console.log(`已备份：${file}`);
      break;
    }
    case "restore": {
      const file = rest[0];
      if (!file || !fs.existsSync(file)) throw new Error("请指定存在的备份文件");
      for (const f of [dbPath(), `${dbPath()}-wal`, `${dbPath()}-shm`]) fs.rmSync(f, { force: true });
      fs.copyFileSync(file, dbPath());
      console.log(`已从 ${file} 恢复数据库`);
      break;
    }
    case "info": {
      getDb();
      console.log(JSON.stringify({ db: dbPath(), schema: SCHEMA_VERSION, admins: adminCount() }, null, 2));
      break;
    }
    default:
      console.log("用法：cli.ts migrate | admin [--user 名称] [--password 密码] | backup | restore 文件 | info");
      process.exitCode = cmd ? 1 : 0;
  }
}

main().catch((e) => {
  console.error(`错误：${(e as Error).message}`);
  process.exit(1);
});
