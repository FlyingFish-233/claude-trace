#!/usr/bin/env node
/** @file opencode-cli.ts @description opencode capture launcher. */
import { opencodeProfile } from "../tools/opencode";
import { launchClient, cliFailure } from "./client-launcher";
launchClient(opencodeProfile).catch(cliFailure);
