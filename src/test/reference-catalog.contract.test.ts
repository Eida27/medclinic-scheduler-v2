import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const collegeId = (suffix: number) => `10000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;
const programId = (suffix: number) => `20000000-0000-4000-8000-${String(suffix).padStart(12, "0")}`;

const colleges = [
  [1, "COEng", "College of Engineering"],
  [2, "CON", "College of Nursing"],
  [3, "CCS", "College of Computer Studies"],
  [4, "CARES", "College of Agriculture, Resources, and Environmental Sciences"],
  [5, "CAS", "College of Arts and Sciences"],
  [6, "CBA", "College of Business and Accountancy"],
  [7, "CED", "College of Education"],
  [8, "CHM", "College of Hospitality Management"],
  [9, "CMLS", "College of Medical Laboratory Science"],
  [10, "COP", "College of Pharmacy"],
  [11, "COL", "College of Law"],
  [12, "COM", "College of Medicine"],
  [13, "COT", "College of Theology"],
] as const;

const programs = [
  [4, 4, "BSA", "Bachelor of Science in Agriculture"],
  [5, 4, "BSEM", "Bachelor of Science in Environmental Management"],
  [6, 4, "BSABE", "Bachelor of Science in Agricultural and Biosystems Engineering"],
  [7, 5, "BA ELS", "Bachelor of Arts in English Language Studies"],
  [8, 5, "BA Com", "Bachelor of Arts in Mass Communication"],
  [9, 5, "BASPSPA", "Bachelor of Arts in Political Science & Public Administration"],
  [10, 5, "BS Psych", "Bachelor of Science in Psychology"],
  [11, 5, "BS Bio", "Bachelor of Science in Biology"],
  [12, 5, "BS BioMic", "Bachelor of Science in Biology with specialization in Microbiology"],
  [13, 5, "BS Chem", "Bachelor of Science in Chemistry"],
  [14, 5, "BS Math", "Bachelor of Science in Mathematics"],
  [15, 5, "BS SW", "Bachelor of Science in Social Work"],
  [16, 6, "BSA", "Bachelor of Science in Accountancy"],
  [17, 6, "BSBA BM", "Bachelor of Science in Business Administration Major in Business Management"],
  [18, 6, "BSBAFM", "Bachelor of Science in Business Administration Major in Financial Management"],
  [19, 6, "BSBAMM", "Bachelor of Science in Business Administration Major in Marketing Management"],
  [20, 6, "BSEnt", "Bachelor of Science in Entrepreneurship"],
  [21, 6, "BSMA", "Bachelor of Science in Management Accounting"],
  [22, 6, "BSBAHRM", "Bachelor of Science in Business Administration Major in Human Resource Management"],
  [23, 3, "BSCS", "Bachelor of Science in Computer Science"],
  [24, 3, "BSDMIA", "Bachelor of Science in Digital Media and Interactive Arts"],
  [3, 3, "BSIT", "Bachelor of Science in Information Technology"],
  [25, 3, "BSIS", "Bachelor of Science in Information Systems"],
  [26, 3, "BLIS", "Bachelor in Library and Information Science"],
  [27, 7, "BECEd", "Bachelor of Early Childhood Education"],
  [28, 7, "BEEd", "Bachelor of Elementary Education"],
  [29, 7, "BPEd", "Bachelor of Physical Education"],
  [30, 7, "BSEd-E", "Bachelor of Secondary Education major in English"],
  [31, 7, "BSEd-F", "Bachelor of Secondary Education major in Filipino"],
  [32, 7, "BSEd-M", "Bachelor of Secondary Education major in Mathematics"],
  [33, 7, "BSEd-S", "Bachelor of Secondary Education major in Science"],
  [34, 7, "BSNEd", "Bachelor of Secondary Education major in Special Needs Education"],
  [35, 1, "BSChE", "Bachelor of Science in Chemical Engineering"],
  [1, 1, "BSCE", "Bachelor of Science in Civil Engineering"],
  [36, 1, "BSEE", "Bachelor of Science in Electrical Engineering"],
  [37, 1, "BSECE", "Bachelor of Science in Electronics Engineering"],
  [38, 1, "BSME", "Bachelor of Science in Mechanical Engineering"],
  [39, 1, "BSPkgE", "Bachelor of Science in Packaging Engineering"],
  [40, 1, "BSSE", "Bachelor of Science in Software Engineering"],
  [41, 8, "BSHM", "Bachelor of Science in Hospitality Management"],
  [42, 8, "BSTM", "Bachelor of Science in Tourism Management"],
  [43, 9, "BSMLS", "Bachelor of Science in Medical Laboratory Science"],
  [2, 2, "BSN", "Bachelor of Science in Nursing"],
  [44, 10, "BSPharm", "Bachelor of Science in Pharmacy"],
  [45, 11, "JD", "Juris Doctor"],
  [46, 12, "BSRT", "Bachelor of Science in Respiratory Therapy"],
  [47, 12, "MD", "Doctor of Medicine"],
  [48, 13, "BTh", "Bachelor of Theology"],
] as const;

function insertBody(sql: string, table: string) {
  const match = sql.match(new RegExp(`INSERT INTO ${table} \\([^;]+?VALUES([\\s\\S]+?)ON CONFLICT`, "u"));
  expect(match, `missing ${table} insert`).not.toBeNull();
  return match![1];
}

describe("CPU reference catalog seed", () => {
  it("contains the exact 13-college workbook catalog", async () => {
    const seed = await readFile(resolve("database/seeds/001_reference_and_users.sql"), "utf8");
    const body = insertBody(seed, "colleges");
    expect(body.match(/\('10000000-/gu)).toHaveLength(13);
    for (const [id, code, name] of colleges) {
      expect(body).toContain(`('${collegeId(id)}', '${code}', '${name}')`);
    }
  });

  it("contains the exact 48 college-scoped workbook programs", async () => {
    const seed = await readFile(resolve("database/seeds/001_reference_and_users.sql"), "utf8");
    const body = insertBody(seed, "programs");
    expect(body.match(/\('20000000-/gu)).toHaveLength(48);
    for (const [id, parentId, code, name] of programs) {
      expect(body).toContain(`('${programId(id)}', '${collegeId(parentId)}', '${code}', '${name}')`);
    }
  });

  it("removes Graduating and closes the remaining priority ranks", async () => {
    const seed = await readFile(resolve("database/seeds/001_reference_and_users.sql"), "utf8");
    const body = insertBody(seed, "priority_groups");
    expect(body).not.toContain("Graduating");
    expect(body.match(/\('30000000-/gu)).toHaveLength(3);
    expect(body).toContain("'30000000-0000-4000-8000-000000000002', 'OJT', 1");
    expect(body).toContain("'30000000-0000-4000-8000-000000000003', 'Tour', 2");
    expect(body).toContain("'30000000-0000-4000-8000-000000000004', 'Regular', 3");
  });
});

describe("CPU reference catalog migration", () => {
  it("reconciles existing databases through the guarded cleanup boundary", async () => {
    const path = resolve("database/migrations/012_cpu_reference_catalog.sql");
    expect(existsSync(path)).toBe(true);
    const migration = await readFile(path, "utf8");

    expect(migration.match(/\('10000000-/gu)).toHaveLength(13);
    expect(migration.match(/\('20000000-/gu)).toHaveLength(48);
    expect(migration).toContain("npm run db:reference-catalog-cleanup -- apply");
    expect(migration).toContain("DELETE FROM programs");
    expect(migration).toContain("DELETE FROM colleges");
    expect(migration).toMatch(/UPDATE coordinator_schedule_items[\s\S]+SET priority_group_id = NULL/u);
    expect(migration).toMatch(/DELETE FROM priority_groups[\s\S]+Graduating/u);
    expect(migration).toContain("'OJT', 1");
    expect(migration).toContain("'Tour', 2");
    expect(migration).toContain("'Regular', 3");
  });

  it("exposes the guarded cleanup command through npm", async () => {
    const packageJson = JSON.parse(await readFile(resolve("package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(packageJson.scripts["db:reference-catalog-cleanup"])
      .toBe("tsx --env-file=.env.local scripts/db-reference-catalog-cleanup.ts");
  });
});
