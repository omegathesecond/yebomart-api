// Operator-only entry point for the VPC-connected migration job. No HTTP route.
import { execFileSync } from "child_process";
import { PrismaClient } from "@prisma/client";
const name = "20261116020000_restaurant_workspace";
const cli = "node_modules/prisma/build/index.js";
function run(args: string[]) {
  try {
    return execFileSync("node", [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e: any) {
    throw new Error(
      String(e.stderr ?? "Migration command failed")
        .split(process.env.DATABASE_URL ?? "INVALID_SECRET")
        .join("[redacted]"),
    );
  }
}
async function main() {
  const db = new PrismaClient();
  try {
    console.log(
      "Authority:",
      await db.$queryRaw`SELECT current_database(),session_user,current_user`,
    );
    const migrations =
      await db.$queryRaw`SELECT migration_name, finished_at IS NOT NULL AS applied, rolled_back_at IS NOT NULL AS rolled_back FROM _prisma_migrations ORDER BY started_at`;
    console.log("Migration records:", JSON.stringify(migrations));
    if (process.argv[2] === "apply") {
      console.log(
        run([
          "db",
          "execute",
          "--file",
          "prisma/migrations/" + name + "/migration.sql",
          "--schema",
          "prisma/schema.prisma",
        ]),
      );
      console.log(run(["migrate", "resolve", "--applied", name]));
    }
    console.log("SCHEMA_DIFF_BEGIN");
    console.log(
      run([
        "migrate",
        "diff",
        "--from-url",
        process.env.DATABASE_URL!,
        "--to-schema-datamodel",
        "prisma/schema.prisma",
        "--script",
      ]),
    );
    console.log("SCHEMA_DIFF_END");
  } finally {
    await db.$disconnect();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
