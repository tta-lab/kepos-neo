import path from "node:path";

import { takeOptionValue } from "./cli.js";
import { writePublisherContact } from "./setup-client.js";

interface ContactCliOptions {
  stateDir: string;
  label: string;
  homeKey: string;
}

function parseContactCliOptions(arguments_: readonly string[]): ContactCliOptions {
  const options: ContactCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "client"),
    label: "",
    homeKey: "",
  };
  for (let index = 0; index < arguments_.length; index += 2) {
    const option = arguments_[index] ?? "option";
    const value = takeOptionValue(arguments_, index, option);
    if (option === "--state") {
      options.stateDir = path.resolve(value);
      continue;
    }
    if (option === "--label") {
      options.label = value;
      continue;
    }
    if (option === "--home-key") {
      options.homeKey = value;
      continue;
    }
    throw new Error(`unknown publisher contact option: ${option}`);
  }
  if (!options.label || !options.homeKey) {
    throw new Error("--label and --home-key are required");
  }
  return options;
}

writePublisherContact(parseContactCliOptions(process.argv.slice(2)))
  .then((contactPath) => console.log(`Publisher contact: ${contactPath}`))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
