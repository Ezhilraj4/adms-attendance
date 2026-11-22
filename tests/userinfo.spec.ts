import { describe, expect, it } from "vitest";
import { parseUserinfoBody } from "../src/adms/parsers/userinfo";

describe("parseUserinfoBody", () => {
  it("reads USER key/value uploads from OPERLOG without treating credentials as names", () => {
    expect(parseUserinfoBody("USER PIN=001\tName=Rahul Kumar\tPri=0\tPasswd=secret").users)
      .toEqual([{ pin: "001", name: "Rahul Kumar" }]);
    expect(parseUserinfoBody("PIN=002 Name=Priya Sharma Pri=0").users)
      .toEqual([{ pin: "002", name: "Priya Sharma" }]);
  });
  it("parses the standard tab-separated USERINFO format", () => {
    const result = parseUserinfoBody("101\tRahul Kumar\t0\t\t\t1\n102\tPriya Sharma\t0");
    expect(result.users).toEqual([
      { pin: "101", name: "Rahul Kumar" },
      { pin: "102", name: "Priya Sharma" },
    ]);
    expect(result.errors).toHaveLength(0);
  });

  it("accepts key/value firmware variants and reports incomplete lines", () => {
    const result = parseUserinfoBody("PIN=103,Name=Amit Singh\n104\t\t0");
    expect(result.users).toEqual([{ pin: "103", name: "Amit Singh" }]);
    expect(result.errors).toHaveLength(1);
  });
});
