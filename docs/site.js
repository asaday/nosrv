const pageParts = location.pathname.split("/").filter(Boolean);
const isGitHubPages = location.hostname.endsWith(".github.io");
const owner = isGitHubPages ? location.hostname.split(".")[0] : "OWNER";
const repository = isGitHubPages && pageParts.length ? pageParts[0] : "nosrv";
const repositoryUrl = isGitHubPages ? `https://github.com/${owner}/${repository}` : "../";
const createCommand = `npx github:${owner}/${repository} create my-app`;

document.querySelectorAll("[data-repo-link]").forEach((link) => {
  link.href = repositoryUrl;
});

document.querySelectorAll("[data-spec-link]").forEach((link) => {
  link.href = isGitHubPages ? `${repositoryUrl}/blob/main/docs/ai-spec.md` : "./ai-spec.md";
});

document.querySelectorAll("[data-create-command]").forEach((element) => {
  element.textContent = createCommand;
});

document.querySelector("[data-copy-command]")?.addEventListener("click", async (event) => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(createCommand);
    button.textContent = "Copied";
    setTimeout(() => {
      button.textContent = "Copy";
    }, 1600);
  } catch {
    button.textContent = "Select and copy";
  }
});
