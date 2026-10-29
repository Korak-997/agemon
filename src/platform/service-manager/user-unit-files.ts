import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readRegularFileIfExists } from "../../core/files.js";
import type { ServiceManager } from "./index.js";
import {
  isAgemonDaemonUnitFile,
  workingDirectoryOfUnit,
} from "./unit-files.js";

export type UserUnitFiles = Pick<
  ServiceManager,
  "unitPathFor" | "readUnitWorkingDirectory" | "findAgemonDaemonUnit"
>;

export function createUserUnitFiles(homeDir: string): UserUnitFiles {
  const unitDirectory = join(homeDir, ".config", "systemd", "user");
  const unitPathFor = (unitName: string) => join(unitDirectory, unitName);

  return {
    unitPathFor,
    async readUnitWorkingDirectory(unitName) {
      const unitContents = await readRegularFileIfExists(unitPathFor(unitName));
      return unitContents === null
        ? null
        : workingDirectoryOfUnit(unitContents);
    },
    async findAgemonDaemonUnit() {
      let unitFileNames: string[];
      try {
        unitFileNames = await readdir(unitDirectory);
      } catch {
        return null;
      }
      return unitFileNames.find(isAgemonDaemonUnitFile) ?? null;
    },
  };
}
