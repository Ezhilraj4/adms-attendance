export interface DeviceUser {
  pin: string;
  name: string;
}

// ZKTeco USERINFO is normally tab-separated:
// PIN<TAB>Name<TAB>Privilege<TAB>Password<TAB>Card<TAB>Group...
// A few firmware versions send key/value fields instead, so accept those too.
export function parseUserinfoBody(body: string): { users: DeviceUser[]; errors: Array<{ line: string; reason: string }> } {
  const users: DeviceUser[] = [];
  const errors: Array<{ line: string; reason: string }> = [];

  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim().replace(/^USER\s+/i, "");
    if (!line) continue;

    let pin = "";
    let name = "";
    const fields = line.split("\t");
    if (fields.length >= 2 && !fields[0].includes("=")) {
      pin = fields[0].trim();
      name = fields[1].trim();
    } else {
      const values = new Map<string, string>();
      for (const part of line.split(/\t|,(?=\s*\w+=)|&(?=\w+=)| +(?=\w+=)/)) {
        const match = part.match(/^\s*([^=]+)=(.*)\s*$/);
        if (match) values.set(match[1].trim().toLowerCase(), match[2].trim());
      }
      pin = values.get("pin") ?? values.get("userid") ?? values.get("user_id") ?? "";
      name = values.get("name") ?? values.get("username") ?? "";
    }

    if (!pin || !name || /[\u0000-\u001f]/.test(pin + name) || pin.length > 100 || name.length > 200) {
      errors.push({ line, reason: "USERINFO line does not contain both PIN and name" });
      continue;
    }
    users.push({ pin, name });
  }
  return { users, errors };
}
