import path from "node:path";

import { takeOptionValue } from "./cli.js";
import { writePublisherContact } from "./setup-client.js";

interface ContactCliOptions {
  stateDir: string;
  label: string;
  publisherKey: string;
}

function parseContactCliOptions(arguments_: readonly string[]): ContactCliOptions {
  const options: ContactCliOptions = {
    stateDir: path.resolve("tmp", "dogfood", "client"),
    label: "",
    publisherKey: "",
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
    if (option === "--publisher-key") {
      options.publisherKey = value;
      continue;
    }
    throw new Error(`unknown publisher contact option: ${option}`);
  }
  if (!options.label || !options.publisherKey) {
    throw new Error("--label and --publisher-key are required");
  }
  return options;
}

writePublisherContact(parseContactCliOptions(process.argv.slice(2)))
  .then((contactPath) => console.log(`Publisher contact: ${contactPath}`))
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
