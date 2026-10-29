import type { ServiceManager } from "./index.js";
import type { UserUnitFiles } from "./user-unit-files.js";

const RUN_WHERE_SYSTEMD_RUNS = "run 'agemon nuke' where systemd runs";

function refuseWithoutSystemd(remedy: string): Promise<never> {
  return Promise.reject(
    new Error(`systemd is not running on this machine; ${remedy}.`),
  );
}

export function createUnavailableServiceManager(
  unitFiles: UserUnitFiles,
): ServiceManager {
  const refuseUnit = (unitName: string) =>
    refuseWithoutSystemd(
      `remove ${unitFiles.unitPathFor(unitName)} by hand, or ${RUN_WHERE_SYSTEMD_RUNS}`,
    );
  const refuseLinger = () =>
    refuseWithoutSystemd(
      `agemon cannot manage user linger here; ${RUN_WHERE_SYSTEMD_RUNS}`,
    );

  return {
    kind: "none",
    isActive: async () => ({ active: false }),
    registerAutostart: ({ unitName }) =>
      refuseWithoutSystemd(`agemon cannot register ${unitName} here`),
    unregisterAutostart: ({ unitName }) => refuseUnit(unitName),
    readUnitWorkingDirectory: unitFiles.readUnitWorkingDirectory,
    unitPathFor: unitFiles.unitPathFor,
    isLingerEnabled: refuseLinger,
    enableLinger: refuseLinger,
    disableLinger: refuseLinger,
    findAgemonDaemonUnit: unitFiles.findAgemonDaemonUnit,
  };
}
