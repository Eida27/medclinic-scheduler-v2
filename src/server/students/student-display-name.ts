import "server-only";

export function studentDisplayNameSql(alias: string) {
  const firstName = `BTRIM(${alias}.first_name)`;
  const middleName = `NULLIF(BTRIM(${alias}.middle_name), '')`;
  const lastName = `BTRIM(${alias}.last_name)`;
  const suffix = `NULLIF(BTRIM(${alias}.suffix), '')`;

  return `CONCAT(
    ${lastName}, ', ', ${firstName},
    CASE WHEN ${middleName} IS NULL
      THEN ''
      ELSE CONCAT(' ', UPPER(LEFT(${middleName}, 1)), '.')
    END,
    CASE WHEN ${suffix} IS NULL
      THEN ''
      ELSE CONCAT(' (', ${suffix}, ')')
    END
  )`;
}
