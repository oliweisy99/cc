import { BrowserUseClient } from "browser-use-sdk";

const client = new BrowserUseClient({
  apiKey: "bu_zT9SRdOnKbxQQ78tkzYIwESgUY5zFGH7a9cTsx_7FjI",
});

async function main() {
  const task = await client.tasks.createTask({
    task: "Search for the top 10 Hacker News posts and return the title and url.",
  });

  const result = await task.complete();
  console.log(result.output);
}

main();
