// Loaded with --import by the suites that start the server as a child process. The named file
// does not exist, so the server sees a host that was never registered and the suite tests the
// same behaviour on this machine as on CI, whatever registration the host carries.
import { setPolicyFileForTest } from "../src/mcp/admission.mjs";

const file = process.env.THRIFTYRELAY_TEST_POLICY_FILE;
if (!file) throw new Error("THRIFTYRELAY_TEST_POLICY_FILE is required");
setPolicyFileForTest(file);
