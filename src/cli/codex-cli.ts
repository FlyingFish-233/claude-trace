#!/usr/bin/env node
/** @file codex-cli.ts @description codex capture launcher. */
import { codexProfile } from "../tools/codex";
import { launchClient, cliFailure } from "./client-launcher";
launchClient(codexProfile).catch(cliFailure);
