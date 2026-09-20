import { getTableConfig, type SQLiteColumn } from "drizzle-orm/sqlite-core";
import { controlPlaneTables } from "./schema.ts";

const queryConfig = {
  escapeName: (name: string) => `"${name.replaceAll('"', '""')}"`,
  escapeParam: (_num: number, value: unknown) => literal(value),
  escapeString: (value: string) => `'${value.replaceAll("'", "''")}'`,
};

function literal(value: unknown): string {
  if (value === null || value === undefined) {
    return "NULL";
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "boolean") {
    return value ? "1" : "0";
  }
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quote(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

function columnSql(column: SQLiteColumn): string {
  const parts = [quote(column.name), column.getSQLType()];
  if (column.primary) {
    parts.push("PRIMARY KEY");
  }
  if (column.notNull && !column.primary) {
    parts.push("NOT NULL");
  }
  if (column.isUnique) {
    parts.push("UNIQUE");
  }
  return parts.join(" ");
}

function emitCreateTable(table: (typeof controlPlaneTables)[number]): {
  table: string;
  indexes: string[];
} {
  const config = getTableConfig(table);
  const parts = config.columns.map(columnSql);

  for (const primaryKey of config.primaryKeys) {
    const columns = primaryKey.columns.map((column) => quote(column.name)).join(", ");
    parts.push(`PRIMARY KEY (${columns})`);
  }

  for (const unique of config.uniqueConstraints) {
    const columns = unique.columns.map((column) => quote(column.name)).join(", ");
    const name = unique.name ? `CONSTRAINT ${quote(unique.name)} ` : "";
    parts.push(`${name}UNIQUE (${columns})`);
  }

  for (const foreignKey of config.foreignKeys) {
    const reference = foreignKey.reference();
    const columns = reference.columns.map((column) => quote(column.name)).join(", ");
    const foreignName = getTableConfig(reference.foreignTable).name;
    const foreignColumns = reference.foreignColumns.map((column) => quote(column.name)).join(", ");
    const actions = [
      foreignKey.onUpdate ? `ON UPDATE ${foreignKey.onUpdate.toUpperCase()}` : "",
      foreignKey.onDelete ? `ON DELETE ${foreignKey.onDelete.toUpperCase()}` : "",
    ]
      .filter((part) => part.length > 0)
      .join(" ");
    parts.push(
      `FOREIGN KEY (${columns}) REFERENCES ${quote(foreignName)} (${foreignColumns})${actions ? ` ${actions}` : ""}`,
    );
  }

  for (const check of config.checks) {
    const rendered = check.value.toQuery(queryConfig).sql;
    parts.push(`CONSTRAINT ${quote(check.name)} CHECK (${rendered})`);
  }

  const tableSql = `CREATE TABLE ${quote(config.name)} (\n  ${parts.join(",\n  ")}\n) STRICT;`;
  const indexes = config.indexes.map((index) => {
    const unique = index.config.unique ? "UNIQUE " : "";
    const columns = index.config.columns
      .map((column) =>
        typeof column === "object" && "name" in column ? quote(column.name) : String(column),
      )
      .join(", ");
    return `CREATE ${unique}INDEX ${quote(index.config.name)} ON ${quote(config.name)} (${columns});`;
  });
  return { table: tableSql, indexes };
}

/** Reproduce CREATE TABLE STRICT + indexes from the Drizzle schema. */
export function generateControlPlaneSql(): string {
  const statements: string[] = [
    "-- Generated from src/db/schema.ts. STRICT appended per approved patch.",
    "-- Schema identity: dymoo-llm-router-control-plane version 1.",
    "-- Not compatible with unpublished jev-router-drizzle v1 databases.",
  ];
  for (const table of controlPlaneTables) {
    const emitted = emitCreateTable(table);
    statements.push(emitted.table);
    statements.push(...emitted.indexes);
  }
  return `${statements.join("\n\n")}\n`;
}
