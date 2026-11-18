/**
 * Mixes the sound of an export, and what AI hears, away from the page, see `workerMixer`: the same
 * mix engine as the preview, with the files the page finds.
 */
import { serveMixer, type MixPort } from "@animaquill/audio";

serveMixer(self as unknown as MixPort);
