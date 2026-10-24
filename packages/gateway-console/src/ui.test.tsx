import { expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { ActivityTable } from "./Activity";
import { CopyButton, Drawer, MiniLog, Modal } from "./ui";
import { ReauthDialog } from "./Auth";
import type { Activity } from "./types";

it.each([ActivityTable, MiniLog])(
  "preserves existing activity nodes when a row is prepended (%s)",
  (Component) => {
    const row: Activity = {
      id: 1,
      ts: 1000,
      type: "rpc.finished",
      requestId: "first",
      engineId: "engine-a",
      method: "fs.read",
    };
    const view = render(<Component rows={[row]} />);
    const node = view.getByText("fs.read");
    view.rerender(
      <Component
        rows={[{ ...row, id: 2, requestId: "next", method: "fs.write" }, row]}
      />,
    );
    expect(view.getByText("fs.read")).toBe(node);
  },
);

it("focuses dialogs, cycles Tab and restores the opener", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const close = vi.fn();
  const view = render(
    <Modal title="Test" onCancel={close}>
      <button>First</button>
      <button>Last</button>
    </Modal>,
  );
  expect(screen.getByText("First")).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab", shiftKey: true });
  expect(screen.getByText("Last")).toHaveFocus();
  fireEvent.keyDown(window, { key: "Tab" });
  expect(screen.getByText("First")).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(close).toHaveBeenCalledOnce();
  view.unmount();
  expect(opener).toHaveFocus();
  opener.remove();
});

it("only closes the top overlay and restores drawer focus", () => {
  const drawerClose = vi.fn();
  const modalClose = vi.fn();
  const view = render(
    <Drawer title="Device" label="Device" onClose={drawerClose}>
      <button>Action</button>
    </Drawer>,
  );
  const drawerButton = screen.getByText("Close");
  expect(drawerButton).toHaveFocus();
  view.rerender(
    <Drawer title="Device" label="Device" onClose={drawerClose}>
      <button>Action</button>
      <Modal title="Confirm" onCancel={modalClose}>
        <button>Cancel</button>
      </Modal>
    </Drawer>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(modalClose).toHaveBeenCalledOnce();
  expect(drawerClose).not.toHaveBeenCalled();
  view.rerender(
    <Drawer title="Device" label="Device" onClose={drawerClose}>
      <button>Action</button>
    </Drawer>,
  );
  expect(drawerButton).toHaveFocus();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(drawerClose).toHaveBeenCalledOnce();
});

it("cancels reauthentication with Escape without confirming", () => {
  const onCancel = vi.fn();
  const onConfirm = vi.fn();
  render(<ReauthDialog onCancel={onCancel} onConfirm={onConfirm} />);
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledOnce();
  expect(onConfirm).not.toHaveBeenCalled();
});

it("keeps a one-time credential dialog open on Escape", () => {
  render(
    <Modal title="Credential">
      <button>I saved it</button>
    </Modal>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeInTheDocument();
});

it("copies an exact one-time credential with feedback and no browser storage", async () => {
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const storage = vi.spyOn(Storage.prototype, "setItem");
  const token = "one-time-credential-test";
  render(<CopyButton value={token} />);
  fireEvent.click(screen.getByRole("button", { name: "Copy" }));
  expect(await screen.findByRole("button", { name: "Copied" })).toBeVisible();
  expect(writeText).toHaveBeenCalledWith(token);
  expect(storage).not.toHaveBeenCalled();
  expect(JSON.stringify(window.localStorage)).not.toContain(token);
  expect(JSON.stringify(window.sessionStorage)).not.toContain(token);
  vi.restoreAllMocks();
});
it("selects a readonly fallback when clipboard access fails", async () => {
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: undefined,
  });
  render(<CopyButton value={"token\ncommand"} />);
  fireEvent.click(screen.getByText("Copy"));
  const input = (await screen.findByLabelText(
    "Copy manually",
  )) as HTMLTextAreaElement;
  expect(input).toHaveFocus();
  expect(input.value.slice(input.selectionStart, input.selectionEnd)).toBe(
    "token\ncommand",
  );
  vi.restoreAllMocks();
});

it("ignores Escape while a dismissible overlay shows a one-time credential", () => {
  const onClose = vi.fn();
  const view = render(
    <Modal title="Add device" onClose={onClose} dismissible={false}>
      <button>Copy token</button>
    </Modal>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  view.rerender(
    <Modal title="Add device" onClose={onClose}>
      <button>Done</button>
    </Modal>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  view.unmount();
  const onDrawerClose = vi.fn();
  render(
    <Drawer
      label="Device"
      title="nas-01"
      onClose={onDrawerClose}
      dismissible={false}
    >
      <code>token</code>
    </Drawer>,
  );
  fireEvent.keyDown(window, { key: "Escape" });
  expect(onDrawerClose).not.toHaveBeenCalled();
});

it("returns focus to the node that swapped in a drawer, not the first one", () => {
  function Harness({ open }: { open: string }) {
    return (
      <>
        <button>a</button>
        <button>b</button>
        {open && (
          <Drawer key={open} label="Device" title={open} onClose={() => {}}>
            <span>{open}</span>
          </Drawer>
        )}
      </>
    );
  }
  const view = render(<Harness open="" />);
  screen.getByText("a").focus();
  view.rerender(<Harness open="a" />);
  screen.getByText("b").focus();
  view.rerender(<Harness open="b" />);
  // Swapping drawers must not pull focus back to the first node.
  expect(screen.getByText("a")).not.toHaveFocus();
  view.rerender(<Harness open="" />);
  expect(screen.getByText("b")).toHaveFocus();
});
