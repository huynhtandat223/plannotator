# Keep Ex-Plannotator independent from Official Plannotator

Ex-Plannotator will have its own Pi extension, browser app, server, package identity, and initial `/ex-plannotator-last` command. It may reuse stable annotation libraries from `packages/ui` and shared types from `packages/shared`, but it will not modify or register through the Official Plannotator app. This allows both packages to coexist without changing or shadowing the official one-shot review behavior, while avoiding a costly copy of the annotation engine.
