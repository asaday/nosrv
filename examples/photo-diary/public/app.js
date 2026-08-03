const entries = document.querySelector("#entries");

async function load() {
  const data = await fetch("api/entries").then((response) => response.json());
  document.querySelector("#user").textContent = `User: ${data.userId}`;
  entries.replaceChildren(
    ...data.entries.map((entry) => {
      const article = document.createElement("article");
      const remove = document.createElement("button");
      remove.textContent = "Delete";
      remove.className = "delete";
      remove.onclick = async () => {
        await fetch(`api/entries/${entry.id}`, { method: "DELETE" });
        await load();
      };
      const date = document.createElement("small");
      date.textContent = new Date(entry.created_at).toLocaleString();
      const body = document.createElement("p");
      body.textContent = entry.body;
      const image = document.createElement("img");
      image.src = `api/photos/${encodeURIComponent(entry.id)}`;
      image.alt = "Diary photo";
      article.append(remove, date, body, image);
      return article;
    }),
  );
}

document.querySelector("#post").onsubmit = async (event) => {
  event.preventDefault();
  const response = await fetch("api/entries", {
    method: "POST",
    body: new FormData(event.target),
  });
  if (!response.ok) alert((await response.json()).error);
  else {
    event.target.reset();
    await load();
  }
};

await load();
