import { describe, expect, it } from "vitest";
import {
  RESULT_FILE_MAX_BYTES,
  RESULT_SUBMISSION_MAX_BYTES,
} from "@/shared/student-result-file-rules";
import { validateResultFileSelection } from "./result-selection-validation";

const file = (name: string, byteSize = 8) => new File(
  [new Uint8Array(byteSize)],
  name,
);

describe("validateResultFileSelection", () => {
  it.each(["result.pdf", "result.jpg", "result.jpeg", "result.png", "result.PDF"])(
    "keeps supported extension %s eligible for upload",
    (filename) => {
      const result = validateResultFileSelection([file(filename)], {
        currentFileCount: 0,
        currentTotalBytes: 0,
      });

      expect(result).toEqual({
        rows: [{
          file: expect.any(File),
          filename,
          byteSize: 8,
          valid: true,
          error: null,
        }],
        canUpload: true,
        batchError: null,
      });
    },
  );

  it("marks an unsupported extension on its selected row", () => {
    const result = validateResultFileSelection([file("notes.txt")], {
      currentFileCount: 0,
      currentTotalBytes: 0,
    });

    expect(result.rows[0]).toMatchObject({
      filename: "notes.txt",
      valid: false,
      error: "Upload a PDF, JPG, JPEG, or PNG file.",
    });
    expect(result.canUpload).toBe(false);
  });

  it("marks a file over 20 MB on its selected row", () => {
    const oversized = file("oversized.pdf", RESULT_FILE_MAX_BYTES + 1);
    const result = validateResultFileSelection([oversized], {
      currentFileCount: 0,
      currentTotalBytes: 0,
    });

    expect(result.rows[0]).toMatchObject({
      filename: "oversized.pdf",
      byteSize: RESULT_FILE_MAX_BYTES + 1,
      valid: false,
      error: "Each result file must be 20 MB or smaller.",
    });
    expect(result.canUpload).toBe(false);
  });

  it("blocks a selection that would exceed 10 resulting files", () => {
    const result = validateResultFileSelection(
      [file("first.pdf"), file("second.png")],
      { currentFileCount: 9, currentTotalBytes: 32 },
    );

    expect(result.rows.every((row) => row.valid)).toBe(true);
    expect(result).toMatchObject({
      canUpload: false,
      batchError: "A result submission may contain at most 10 files.",
    });
  });

  it("blocks a selection that would exceed 50 MB resulting bytes", () => {
    const result = validateResultFileSelection(
      [file("additional.pdf", 2)],
      {
        currentFileCount: 1,
        currentTotalBytes: RESULT_SUBMISSION_MAX_BYTES - 1,
      },
    );

    expect(result.rows[0].valid).toBe(true);
    expect(result).toMatchObject({
      canUpload: false,
      batchError: "A result submission may contain at most 50 MB.",
    });
  });

  it("blocks the entire mixed selection while retaining each row result", () => {
    const result = validateResultFileSelection(
      [file("valid.pdf"), file("invalid.exe")],
      { currentFileCount: 0, currentTotalBytes: 0 },
    );

    expect(result.rows).toEqual([
      expect.objectContaining({ filename: "valid.pdf", valid: true, error: null }),
      expect.objectContaining({
        filename: "invalid.exe",
        valid: false,
        error: "Upload a PDF, JPG, JPEG, or PNG file.",
      }),
    ]);
    expect(result.canUpload).toBe(false);
  });

  it("allows one valid PDF, JPEG, and PNG selection", () => {
    const selected = [
      file("laboratory.pdf"),
      file("photo.jpeg"),
      file("scan.png"),
    ];

    const result = validateResultFileSelection(selected, {
      currentFileCount: 2,
      currentTotalBytes: 128,
    });

    expect(result.rows.map(({ filename, valid, error }) => ({ filename, valid, error }))).toEqual([
      { filename: "laboratory.pdf", valid: true, error: null },
      { filename: "photo.jpeg", valid: true, error: null },
      { filename: "scan.png", valid: true, error: null },
    ]);
    expect(result.canUpload).toBe(true);
    expect(result.batchError).toBeNull();
  });
});
