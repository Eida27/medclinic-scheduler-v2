import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ReportExportButton } from "./ReportExportButton";

describe("ReportExportButton", () => {
  const fetchMock = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("URL", {
      createObjectURL: vi.fn(() => "blob:report"),
      revokeObjectURL: vi.fn(),
    });
  });

  afterEach(() => vi.unstubAllGlobals());

  it("downloads a PDF using the normalized report filters", async () => {
    fetchMock.mockResolvedValue(new Response(new Blob(["pdf"]), {
      status: 200,
      headers: { "content-disposition": "attachment; filename=cpu-report.pdf" },
    }));
    render(<ReportExportButton query="academicYearStart=2025&overallStatus=COMPLIED&sort=name_asc" />);

    await userEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports/export/pdf?academicYearStart=2025&overallStatus=COMPLIED&sort=name_asc",
      { method: "GET" },
    );
    expect(URL.createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(click).toHaveBeenCalledOnce();
    const downloadLink = click.mock.instances[0];
    expect(downloadLink).toHaveProperty("download", "cpu-report.pdf");
    expect(downloadLink).toHaveProperty("href", "blob:report");
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:report");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows an inline failure while preserving the same filtered export target", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      error: { code: "REPORT_EXPORT_TOO_LARGE", message: "Narrow the filters and try again." },
    }), {
      status: 503,
      headers: { "content-type": "application/json" },
    }));
    render(<ReportExportButton query="academicYearStart=2025&collegeId=college-1&sort=year_desc" />);

    await userEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Narrow the filters and try again.");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/reports/export/pdf?academicYearStart=2025&collegeId=college-1&sort=year_desc",
      { method: "GET" },
    );
    expect(screen.getByRole("button", { name: "Export PDF" })).toBeEnabled();
  });

  it("uses the safe filename and error fallbacks when response metadata is absent", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response(new Blob(["pdf"]), { status: 200 }))
      .mockResolvedValueOnce(new Response("not-json", { status: 500 }));
    render(<ReportExportButton query="academicYearStart=2025" />);

    await userEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(click.mock.instances[0]).toHaveProperty("download", "compliance-report.pdf");

    await userEvent.click(screen.getByRole("button", { name: "Export PDF" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Unable to export the report. Try again.");
  });

  it("does not attempt export when the current report has no records", async () => {
    render(<ReportExportButton query="academicYearStart=2025" disabled />);

    await userEvent.click(screen.getByRole("button", { name: "Export PDF" }));

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
