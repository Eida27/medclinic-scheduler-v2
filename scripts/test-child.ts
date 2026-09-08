import { spawn } from "node:child_process";

export async function runTestChild(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, args, { env, stdio: "inherit" });
    const interrupt = () => child.kill("SIGTERM");
    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);
    function removeListeners() {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
    child.on("error", (error) => { removeListeners(); reject(error); });
    child.on("exit", (code, signal) => {
      removeListeners();
      if (code === 0) resolve();
      else reject(new Error(`Test child failed: exit=${code}, signal=${signal ?? "none"}`));
    });
  });
}
