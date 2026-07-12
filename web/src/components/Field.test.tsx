import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Field } from "./Field.tsx";

describe("Field", () => {
  it("ties the label to the control so getByLabelText finds it", () => {
    render(
      <Field label="Base domain">
        <input className="input" defaultValue="ubhi.io" />
      </Field>,
    );
    const input = screen.getByLabelText("Base domain") as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(input.value).toBe("ubhi.io");
    // the <label> htmlFor must equal the input id
    expect(screen.getByText("Base domain").getAttribute("for")).toBe(input.id);
  });

  it("wires the hint as aria-describedby", () => {
    render(
      <Field label="Public IP" hint="Used by the ACME challenge.">
        <input className="input" />
      </Field>,
    );
    const input = screen.getByLabelText("Public IP");
    const describedBy = input.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe("Used by the ACME challenge.");
  });

  it("reuses the child's own id when it has one", () => {
    render(
      <Field label="Email">
        <input id="my-email" className="input" />
      </Field>,
    );
    expect(screen.getByLabelText("Email").id).toBe("my-email");
  });
});
