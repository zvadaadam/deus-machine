import { describe, expect, it } from "vitest";
import { parseEnvFile } from "@/features/settings/lib/parse-env-file";

describe("environment file import", () => {
  it("reads dotenv and dev.vars quoting, comments, exports, CRLF and empty values", () => {
    expect(
      parseEnvFile(
        '\uFEFF# comment\r\nexport APP_MODE=preview # comment\r\nURL="https://test/?a=b#c"\r\nKEY=\'two\nlines\'\r\nESCAPED="one\\ntwo"\r\nEMPTY=\r\n'
      )
    ).toEqual([
      { name: "APP_MODE", value: "preview" },
      { name: "URL", value: "https://test/?a=b#c" },
      { name: "KEY", value: "two\nlines" },
      { name: "ESCAPED", value: "one\ntwo" },
      { name: "EMPTY", value: "" },
    ]);
  });
  it("keeps expansion syntax literal and permits special object-property names", () => {
    expect(parseEnvFile('TOKEN="${OTHER} $(echo secret)"\n__proto__=value')).toEqual([
      { name: "TOKEN", value: "${OTHER} $(echo secret)" },
      { name: "__proto__", value: "value" },
    ]);
  });
  it.each(['KEY="unterminated', 'KEY="value" trailing', "not an assignment", "1KEY=value"])(
    "rejects malformed input without disclosing values: %s",
    (input) => {
      expect(() => parseEnvFile(input)).toThrow("Invalid environment file at line");
    }
  );
  it("does not silently ignore duplicate names or malformed lines", () => {
    expect(() => parseEnvFile("KEY=first\nKEY=second")).toThrow("KEY appears more than once");
    expect(() => parseEnvFile("KEY=value\ninvalid secret contents")).toThrow("line 2");
  });
  it("bounds import size and rejects empty files", () => {
    expect(() => parseEnvFile("# just comments")).toThrow("No environment variables");
    expect(() => parseEnvFile(`KEY=${"x".repeat(10001)}`)).toThrow("at most 10,000");
    expect(() =>
      parseEnvFile(Array.from({ length: 101 }, (_, i) => `KEY_${i}=value`).join("\n"))
    ).toThrow("up to 100");
  });
});
