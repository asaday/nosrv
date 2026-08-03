const list = document.querySelector("#list");

async function load() {
  const todos = await fetch("api/todos").then((response) => response.json());
  list.replaceChildren(
    ...todos.map((todo) => {
      const item = document.createElement("li");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.checked = Boolean(todo.completed);
      checkbox.onchange = async () => {
        await fetch(`api/todos/${todo.id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ completed: checkbox.checked }),
        });
        await load();
      };
      const title = document.createElement("span");
      title.textContent = todo.title;
      title.className = todo.completed ? "done" : "";
      const remove = document.createElement("button");
      remove.textContent = "Delete";
      remove.className = "delete";
      remove.onclick = async () => {
        await fetch(`api/todos/${todo.id}`, { method: "DELETE" });
        await load();
      };
      item.append(checkbox, title, remove);
      return item;
    }),
  );
}

document.querySelector("#add").onsubmit = async (event) => {
  event.preventDefault();
  const input = event.target.title;
  await fetch("api/todos", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: input.value }),
  });
  input.value = "";
  await load();
};

await load();
