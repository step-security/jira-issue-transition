import * as core from "@actions/core";
import { getInputs, getLoginData } from "./config";
import { createPayload } from "./payload";
import { createHTTPClient, determineTransitionID, transitionIssue } from "./request";
import axios, { AxiosInstance, isAxiosError } from "axios";
import { ActionInputs } from "./types";
import * as fs from "fs";

async function validateSubscription() {
    const eventPath = process.env.GITHUB_EVENT_PATH;
    let repoPrivate: boolean | undefined;

    if (eventPath && fs.existsSync(eventPath)) {
        const eventData = JSON.parse(fs.readFileSync(eventPath, "utf8"));
        repoPrivate = eventData?.repository?.private;
    }

    const upstream = "frieder/jira-issue-transition";
    const action = process.env.GITHUB_ACTION_REPOSITORY;
    const docsUrl = "https://docs.stepsecurity.io/actions/stepsecurity-maintained-actions";

    core.info("");
    core.info("\u001b[1;36mStepSecurity Maintained Action\u001b[0m");
    core.info(`Secure drop-in replacement for ${upstream}`);
    if (repoPrivate === false) core.info("\u001b[32m\u2713 Free for public repositories\u001b[0m");
    core.info(`\u001b[36mLearn more:\u001b[0m ${docsUrl}`);
    core.info("");

    if (repoPrivate === false) return;

    const serverUrl = process.env.GITHUB_SERVER_URL || "https://github.com";
    const body: Record<string, string> = { action: action || "" };
    if (serverUrl !== "https://github.com") body.ghes_server = serverUrl;
    try {
        await axios.post(
            `https://agent.api.stepsecurity.io/v1/github/${process.env.GITHUB_REPOSITORY}/actions/maintained-actions-subscription`,
            body,
            { timeout: 3000 }
        );
    } catch (error) {
        if (isAxiosError(error) && error.response?.status === 403) {
            core.error(
                `\u001b[1;31mThis action requires a StepSecurity subscription for private repositories.\u001b[0m`
            );
            core.error(`\u001b[31mLearn how to enable a subscription: ${docsUrl}\u001b[0m`);
            process.exit(1);
        }
        core.info("Timeout or API not reachable. Continuing to next step.");
    }
}

let hasErrors = false;
const success: string[] = [];
const failed: string[] = [];

run().catch((err: any) => {
    core.setFailed(
        "An unexpected exception has occurred. Check the error stacktrace for more info"
    );
    core.error(err);
});

async function run() {
    await validateSubscription();
    const login = getLoginData();
    const inputs = getInputs();
    const httpClient = createHTTPClient(login, inputs);

    const promises: Promise<void>[] = [];

    for (const issue of inputs.issue) {
        promises.push(processIssue(issue, httpClient, inputs));
    }

    await Promise.all(promises).then(() => {
        setOutput(inputs.issueDelimiter);
        setResult(inputs.failOnError);
    });
}

async function processIssue(issue: string, httpClient: AxiosInstance, inputs: ActionInputs) {
    try {
        const transactionId = await determineTransitionID(httpClient, issue, inputs.transition);
        const payload = createPayload(inputs, transactionId);
        await transitionIssue(httpClient, issue, payload);
        core.info(`Transition of Jira issue [${issue}] successful.`);
        success.push(issue);
    } catch (err: any) {
        hasErrors = true;
        failed.push(issue);
        core.error(`Transition of Jira issue [${issue}] failed.`);
        core.error(JSON.stringify(err.response?.data));
    }
}

function setOutput(issueDelimiter: string) {
    core.setOutput("hasErrors", hasErrors);
    core.setOutput("successful", success.join(issueDelimiter));
    core.setOutput("failed", failed.join(issueDelimiter));
}

function setResult(failOnError: boolean) {
    if (!hasErrors && failed.length === 0) {
        core.info("The transition of all Jira issues was successful");
        return;
    }

    if (failOnError) {
        core.setFailed("The transition of some tickets failed.");
    } else if (hasErrors) {
        core.error("The transition of some tickets failed.");
    }
}
