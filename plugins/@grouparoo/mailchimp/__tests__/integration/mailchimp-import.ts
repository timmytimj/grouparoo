import path from "path";
process.env.GROUPAROO_INJECTED_PLUGINS = JSON.stringify({
  "@grouparoo/mailchimp": { path: path.join(__dirname, "..", "..") },
});
import { helper, ImportWorkflow } from "@grouparoo/spec-helper";
import { api, specHelper } from "actionhero";
import {
  Profile,
  ProfileProperty,
  ProfilePropertyRule,
  Run,
  SimpleAppOptions,
  SimpleDestinationOptions,
} from "@grouparoo/core";

import {
  loadAppOptions,
  loadSourceOptions,
  updater,
} from "../utils/nockHelper";

const nockFile = path.join(__dirname, "../", "fixtures", "mailchimp-import.js");

// these comments to use nock
const newNock = false;
require("./../fixtures/mailchimp-import");
//  or these to make it true
// const newNock = true;
// helper.recordNock(nockFile, updater);

// these used and set by test
const appOptions: SimpleAppOptions = loadAppOptions(newNock);
const sourceOptions: SimpleDestinationOptions = loadSourceOptions(newNock);
const sourceMapping = { "merge_fields.USERID": "userId" };

let actionhero;

describe("integration/runs/mailchimp-import", () => {
  beforeAll(async () => {
    const env = await helper.prepareForAPITest();
    actionhero = env.actionhero;
    await api.resque.queue.connection.redis.flushdb();
  }, helper.setupTime);

  afterAll(async () => {
    await helper.shutdown(actionhero);
  });

  beforeAll(async () => {
    await specHelper.runAction("team:initialize", {
      firstName: "Mario",
      lastName: "Mario",
      password: "P@ssw0rd!",
      email: "mario@example.com",
    });
  });

  beforeAll(async () => {
    await helper.factories.profilePropertyRules();
    helper.disableTestPluginImport();
  });

  describe("import", () => {
    let session;
    let csrfToken;
    let source;
    let app;
    let schedule;
    let recentUser: any;

    test(
      "an administrator can create the related import app and schedule",
      async () => {
        // sign in
        session = await specHelper.buildConnection();
        session.params = { email: "mario@example.com", password: "P@ssw0rd!" };
        const sessionResponse = await specHelper.runAction(
          "session:create",
          session
        );
        expect(sessionResponse.error).toBeUndefined();
        csrfToken = sessionResponse.csrfToken;

        // create an app with an uploaded file
        session.params = {
          csrfToken,
          name: "test import app",
          type: "mailchimp",
          options: appOptions,
          state: "ready",
        };
        const appResponse = await specHelper.runAction("app:create", session);
        expect(appResponse.error).toBeUndefined();
        app = appResponse.app;

        // create the source
        session.params = {
          csrfToken,
          type: "mailchimp-import",
          name: "source",
          appGuid: app.guid,
          options: sourceOptions,
          mapping: sourceMapping,
          state: "ready",
        };

        const sourceResponse = await specHelper.runAction(
          "source:create",
          session
        );
        expect(sourceResponse.error).toBeUndefined();
        source = sourceResponse.source;

        // create the schedule
        session.params = {
          csrfToken,
          name: "test import schedule",
          type: "mailchimp-import",
          sourceGuid: source.guid,
          recurring: false,
          mappings: {
            "merge_fields.USERID": "userId",
            email_address: "email",
            "merge_fields.FNAME": "firstName",
            "merge_fields.LNAME": "lastName",
          },
          state: "ready",
        };
        const scheduleResponse = await specHelper.runAction(
          "schedule:create",
          session
        );
        expect(scheduleResponse.error).toBeUndefined();
        expect(scheduleResponse.schedule.guid).toBeTruthy();
        expect(scheduleResponse.schedule.name).toBe("test import schedule");
        schedule = scheduleResponse.schedule;
      },
      helper.setupTime
    );

    test("we can test the app options", async () => {
      session.params = {
        csrfToken,
        guid: app.guid,
        options: appOptions,
      };
      const { error, test } = await specHelper.runAction("app:test", session);
      expect(error).toBeUndefined();
      expect(test.error).toBeUndefined();
      expect(test.success).toBe(true);
    });

    test("we can see a preview of the data", async () => {
      session.params = {
        csrfToken,
        guid: source.guid,
        options: sourceOptions,
      };
      const { error, preview } = await specHelper.runAction(
        "source:preview",
        session
      );
      expect(error).toBeUndefined();
      expect(preview.length).toBe(10);

      recentUser = preview[0];
      expect(recentUser.email_address).toContain("@");
      expect(recentUser.id).toBeTruthy();
      expect(recentUser["merge_fields.USERID"]).toBeLessThanOrEqual(10);
      expect(recentUser["merge_fields.USERID"]).toBeGreaterThanOrEqual(0);
      expect(recentUser).toEqual(
        expect.objectContaining({
          email_address: recentUser.email_address,
          id: recentUser.id,
          language: expect.any("".constructor),
          last_changed: expect.any("2020-11-10T19:50:53+00:00".constructor),
          "merge_fields.FNAME": expect.any("Dorthy".constructor),
          "merge_fields.LNAME": expect.any("Iston".constructor),
          "merge_fields.LTV": expect.any(Number),
          "merge_fields.USERID": expect.any(Number),
          source: expect.any("Import".constructor),
          "stats.avg_click_rate": expect.any(Number),
          "stats.avg_open_rate": expect.any(Number),
          status: expect.any("subscribed".constructor),
          timestamp_opt: expect.any("2020-11-10T19:50:53+00:00".constructor),
          timestamp_signup: expect.any("".constructor),
          vip: expect.any(Boolean),
        })
      );
    });

    test("the mapping data for the source can be set", async () => {
      session.params = {
        csrfToken,
        guid: source.guid,
        mapping: sourceMapping,
      };
      const { error } = await specHelper.runAction("source:edit", session);
      expect(error).toBeUndefined();
    });

    test("replace the email profile property rule with a new one for this source", async () => {
      const oldRule = await ProfilePropertyRule.findOne({
        where: { key: "email" },
      });
      await oldRule.destroy();

      session.params = {
        csrfToken,
        sourceGuid: source.guid,
        key: "email",
        type: "string",
        unique: true,
        options: { field: "email_address" },
        state: "ready",
      };

      const {
        error,
        profilePropertyRule,
        pluginOptions,
      } = await specHelper.runAction("profilePropertyRule:create", session);
      expect(error).toBeUndefined();
      expect(profilePropertyRule.guid).toBeTruthy();

      // check the pluginOptions
      expect(pluginOptions.length).toBe(1);
      expect(pluginOptions[0].key).toBe("field");
      expect(pluginOptions[0].required).toBe(true);
      expect(pluginOptions[0].options[0].key).toBe("id");
      expect(pluginOptions[0].options[0].examples[0]).toBe(recentUser.id);

      // set the options
      session.params = {
        csrfToken,
        guid: profilePropertyRule.guid,
        options: { field: "email_address" },
      };
      const { error: editError } = await specHelper.runAction(
        "profilePropertyRule:edit",
        session
      );
      expect(editError).toBeUndefined();
    });

    test(
      "schedule can run and create profiles",
      async () => {
        // enqueue the run
        session.params = {
          csrfToken,
          guid: schedule.guid,
        };
        const { error, success } = await specHelper.runAction(
          "schedule:run",
          session
        );
        expect(error).toBeUndefined();
        expect(success).toBe(true);

        // check that the run is enqueued
        const found = await specHelper.findEnqueuedTasks("schedule:run");
        expect(found.length).toEqual(1);
        expect(found[0].args[0].scheduleGuid).toBe(schedule.guid);

        // run the schedule
        const run = await Run.create({
          creatorGuid: schedule.guid,
          creatorType: "schedule",
          state: "running",
        });

        // TODO: these sleeps are for re-enqueing at the same time
        // maybe we should use specHelper.deleteEnqueuedTasks() from actionhero
        await helper.sleep();
        await specHelper.runTask("schedule:run", {
          runGuid: run.guid,
          scheduleGuid: schedule.guid,
        });

        let queue;
        // this made another one
        queue = await specHelper.findEnqueuedTasks("schedule:run");
        expect(queue.length).toEqual(2);
        await helper.sleep();
        await specHelper.runTask("schedule:run", queue[1].args[0]);

        // run the schedule task again to enqueue the determineState task
        queue = await specHelper.findEnqueuedTasks("schedule:run");
        expect(queue.length).toEqual(3);
        await helper.sleep();
        await specHelper.runTask("schedule:run", queue[2].args[0]);

        // run all enqueued associateProfile tasks
        const foundAssociateTasks = await specHelper.findEnqueuedTasks(
          "import:associateProfile"
        );
        expect(foundAssociateTasks.length).toEqual(20); // 2x because all timestamps are the same

        await Promise.all(
          foundAssociateTasks.map((t) =>
            specHelper.runTask("import:associateProfile", t.args[0])
          )
        );

        await ImportWorkflow();

        // run all enqueued export tasks
        const foundExportTasks = await specHelper.findEnqueuedTasks(
          "profile:export"
        );
        expect(foundExportTasks.length).toEqual(10);

        await Promise.all(
          foundExportTasks.map((t) =>
            specHelper.runTask("profile:export", t.args[0])
          )
        );

        await run.afterBatch();
        expect(run.percentComplete).toBe(100);

        // check if the run is done
        const foundRunDetermineStateTasks = await specHelper.findEnqueuedTasks(
          "run:determineState"
        );
        await Promise.all(
          foundRunDetermineStateTasks.map((t) =>
            specHelper.runTask("run:determineState", t.args[0])
          )
        );

        // check the results of the run
        const profilesCount = await Profile.count();
        expect(profilesCount).toBe(10);

        await run.updateTotals();
        expect(run.state).toBe("complete");
        expect(run.importsCreated).toBe(20);
        expect(run.profilesCreated).toBe(10);
        expect(run.profilesImported).toBe(10);
        expect(run.percentComplete).toBe(100);
      },
      helper.longTime
    );

    test("profiles should be created with both the mapping data and additional profile property", async () => {
      const profileGuid = (
        await ProfileProperty.findOne({
          where: { rawValue: "1" },
        })
      ).profileGuid;
      const profile = await Profile.findOne({ where: { guid: profileGuid } });
      const properties = await profile.properties();
      expect(properties.userId.values).toEqual([1]);
      expect(properties.email.values).toEqual(["xejervois0@grouparoo.com"]);
    });

    test(
      "schedule can run and update profiles",
      async () => {
        // NOTE: this assumes all timestamps are the same in Mailchimp last_changed
        // enqueue the run
        session.params = {
          csrfToken,
          guid: schedule.guid,
        };
        const { error, success } = await specHelper.runAction(
          "schedule:run",
          session
        );
        expect(error).toBeUndefined();
        expect(success).toBe(true);

        // check that the run is enqueued
        let queue;
        queue = await specHelper.findEnqueuedTasks("schedule:run");
        expect(queue.length).toEqual(4);
        expect(queue[1].args[0].scheduleGuid).toBe(schedule.guid);

        // run the schedule
        const run = await Run.create({
          creatorGuid: schedule.guid,
          creatorType: "schedule",
          state: "running",
        });
        await specHelper.runTask("schedule:run", {
          runGuid: run.guid,
          scheduleGuid: schedule.guid,
        });

        // run the schedule task again to enqueue the determineState task
        queue = await specHelper.findEnqueuedTasks("schedule:run");
        expect(queue.length).toEqual(5);
        await specHelper.runTask("schedule:run", queue[4].args[0]);

        // run all enqueued associateProfile tasks
        const foundAssociateTasks = await specHelper.findEnqueuedTasks(
          "import:associateProfile"
        );
        expect(foundAssociateTasks.length).toEqual(20 + 10); // imports + profiles

        await Promise.all(
          foundAssociateTasks.map((t) =>
            specHelper.runTask("import:associateProfile", t.args[0])
          )
        );

        await ImportWorkflow();

        // run all enqueued export tasks
        const foundExportTasks = await specHelper.findEnqueuedTasks(
          "profile:export"
        );
        // this count is de-duped from the previous run
        expect(foundExportTasks.length).toEqual(10);

        await Promise.all(
          foundExportTasks.map((t) =>
            specHelper.runTask("profile:export", t.args[0])
          )
        );

        // check the run's completion percentage (before the run is complete)
        await run.afterBatch();
        expect(run.percentComplete).toBe(100);

        // check if the run is done
        const foundRunDetermineStateTasks = await specHelper.findEnqueuedTasks(
          "run:determineState"
        );
        await Promise.all(
          foundRunDetermineStateTasks.map((t) =>
            specHelper.runTask("run:determineState", t.args[0])
          )
        );

        // check the results of the run
        const profilesCount = await Profile.count();
        expect(profilesCount).toBe(10);

        await run.updateTotals();
        expect(run.state).toBe("complete");
        expect(run.importsCreated).toBe(10);
        expect(run.profilesCreated).toBe(0);
        expect(run.profilesImported).toBe(10);
        expect(run.percentComplete).toBe(100);
      },
      helper.longTime
    );
  });
});