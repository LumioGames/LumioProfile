# Third-party components

- Perfetto, Google LLC, Apache-2.0. The wire-compatible protobuf subset in the converter follows the [v58.2 protocol definitions](https://github.com/google/perfetto/tree/v58.2/protos/perfetto/trace). Native Trace Processor is downloaded separately, pinned and checksum-verified; it is not bundled into host applications. [License](https://github.com/google/perfetto/blob/v58.2/LICENSE).
- protobufjs is used only by the independent conversion tool. Its license accompanies the installed package.
- ws is used only by the independent local control service. Its license accompanies the installed package.
- TypeScript, esbuild and Playwright are development/verification dependencies, absent from runtime capture entries.

Exact dependency versions and integrity values are recorded in package-lock.json. No third-party analysis service receives capture data automatically.
