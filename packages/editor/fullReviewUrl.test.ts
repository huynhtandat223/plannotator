import { expect, test } from "bun:test";
import { fullReviewUrlForBrowser } from "./fullReviewUrl";

test("uses the initiating browser's hostname for the isolated review listener", () => {
  expect(fullReviewUrlForBrowser("http://100.70.216.87:19432/?token=secret#changes", 41234))
    .toBe("http://100.70.216.87:41234/");
});

test("preserves a local browser hostname while replacing the port", () => {
  expect(fullReviewUrlForBrowser("http://localhost:19432/", 45678))
    .toBe("http://localhost:45678/");
});

test("rejects an invalid isolated review port", () => {
  expect(() => fullReviewUrlForBrowser("http://localhost:19432/", 0))
    .toThrow("valid listener port");
});
