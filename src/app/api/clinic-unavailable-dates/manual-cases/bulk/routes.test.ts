// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AppError } from "@/lib/errors";
const mocks=vi.hoisted(()=>({user:vi.fn(),action:vi.fn()}));
vi.mock("@/server/auth/current-user",()=>({requireUser:mocks.user}));
vi.mock("@/server/services/manual-resolution-batch.service",()=>({previewManualResolutionBatch:mocks.action,resolveManualResolutionBatch:mocks.action,selectManualResolutionCases:mocks.action,getManualResolutionAvailability:mocks.action}));
import {POST as preview} from "./preview/route";
import {POST as resolve} from "./resolve/route";
import {POST as availability} from "../availability/route";
import {GET as selection} from "../selection/route";
beforeEach(()=>{vi.clearAllMocks();mocks.user.mockResolvedValue({userId:"admin",role:"ADMIN"});mocks.action.mockResolvedValue({ok:true});});
describe("private Admin manual bulk APIs",()=>{
  it.each([preview,resolve,availability,selection])("denies unauthorized access before reading or applying the request",async(route)=>{
    mocks.user.mockRejectedValue(new AppError("FORBIDDEN","Administrator required",403));
    const response=await route(new Request("http://localhost/api?academicYearStart=2026"));
    expect(response.status).toBe(403);expect(response.headers.get("Cache-Control")).toBe("private, no-store");expect(mocks.action).not.toHaveBeenCalled();expect(mocks.user).toHaveBeenCalledWith(["ADMIN"]);
  });
  it.each([preview,resolve,availability])("bounds actual body size and rejects malformed JSON",async(route)=>{
    let response=await route(new Request("http://localhost/api",{method:"POST",body:"x".repeat(65537)}));expect(response.status).toBe(413);
    response=await route(new Request("http://localhost/api",{method:"POST",body:"{"}));expect(response.status).toBe(422);expect(mocks.action).not.toHaveBeenCalled();
  });
  it("passes explicit filters and returns private responses",async()=>{
    const response=await selection(new Request("http://localhost/api?academicYearStart=2026&search=Student"));
    expect(mocks.action).toHaveBeenCalledWith({academicYearStart:"2026",search:"Student"},{userId:"admin",role:"ADMIN"});expect(response.headers.get("Cache-Control")).toBe("private, no-store");expect(await response.json()).toEqual({data:{ok:true}});
  });
});
