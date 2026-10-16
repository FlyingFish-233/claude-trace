#!/usr/bin/env node
/** @file cli.ts @description claude capture launcher. */
import { claudeProfile } from "../tools/claude";
import { launchClient, cliFailure } from "./client-launcher";
launchClient(claudeProfile).catch(cliFailure);
