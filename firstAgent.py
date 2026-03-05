from browser_use import Agent, ChatOpenAI, Browser
from dotenv import load_dotenv
import asyncio

load_dotenv()

browser = Browser(
    executable_path='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    user_data_dir='~/Library/Application Support/Google/Chrome',
    profile_directory='Profile 5',
)

async def main():
    # llm = ChatOpenAI(model="gpt-5.1")
    llm = ChatAnthropic(model="claude-opus-4-5-20250929")
    task = "Compare prices between anthropic and openai"
    agent = Agent(task=task, llm=llm, browser=browser)
    await agent.run()
    await browser.close()

if __name__ == "__main__":
    asyncio.run(main())