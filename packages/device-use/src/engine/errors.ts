export class DeviceUseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeviceUseError";
  }
}

export class SimctlError extends DeviceUseError {
  exitCode?: number;
  stderr?: string;

  constructor(message: string, exitCode?: number, stderr?: string) {
    super(message);
    this.name = "SimctlError";
    this.exitCode = exitCode;
    this.stderr = stderr;
  }
}

export class SimBridgeError extends DeviceUseError {
  code?: string;
  details?: string;

  constructor(message: string, code?: string, details?: string) {
    super(message);
    this.name = "SimBridgeError";
    this.code = code;
    this.details = details;
  }
}

export class ValidationError extends DeviceUseError {
  paramName?: string;

  constructor(message: string, paramName?: string) {
    super(message);
    this.name = "ValidationError";
    this.paramName = paramName;
  }
}

export class DependencyError extends DeviceUseError {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}
