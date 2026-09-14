// Each mounted editor contributes a promise; navigation waits for every guard.
export async function confirmWorkbenchLeave() {
  for (const name of ["procurement-before-leave", "research-before-leave"]) {
    const approvals: Promise<boolean>[] = [];
    const allowed = window.dispatchEvent(new CustomEvent(name, { cancelable: true, detail: {
      waitUntil: (approval: Promise<boolean>) => approvals.push(approval),
    } }));
    if (!allowed || (await Promise.all(approvals)).some(value => !value)) return false;
  }
  return true;
}
