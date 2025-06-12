import config from "./config.ts";
import { unlinkSync, writeFileSync } from "fs";

if (process.argv[2] === "generate") {
  writeFileSync(process.argv[3], JSON.stringify(config, null, 2));
} else if (process.argv[2] === "delete") {
  unlinkSync(process.argv[3]);
}
