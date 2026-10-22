# Working with values and references

Use **Use value from…** beside an eligible node field to select a value already available to that node. Search by name or reference, then select an entry. Tab moves through the controls, Enter selects a focused result, and Escape closes the picker. Canceling the picker does not change the field.

The picker groups:

- **Flow inputs:** values from the flow's input defaults. A caller can override them when it starts the flow.
- **Variables:** values assigned by earlier Set variable nodes.
- **Node outputs:** complete results and known properties from earlier nodes.
- **Loop values:** the current item and index, available while mapping a Loop node's child inputs.

Readable names help identify the source. The saved value uses stable node IDs, so renaming a node does not break its references. Node properties show the full ID and a **Copy node reference** action.

## Literal and reference values

An exact reference such as `${inputs.count}` keeps the source's JSON type. A number stays a number, a boolean stays a boolean, and an object or array remains structured data. A reference inside other text, such as `Found ${inputs.count} items`, produces text.

Value controls support strings, numbers, booleans, objects, arrays, and null. Object and array entries can contain references themselves. The advanced JSON editor remains available for existing or complex configurations; opening the inspector does not rewrite those values.

Structural choices such as the target application and child workflow stay explicit. The picker does not change those choices automatically.

## Detect, then click

1. Configure an image or AI detector that can return a matched rectangle.
2. Connect its **match** output to a Click node.
3. Select the same application target in both nodes.
4. Open **Use value from…** for **Detected result** and select the detector's complete result.
5. Save, validate, and run separately.

This uses the matched rectangle's center. Relay still checks capture freshness and target identity before clicking. A browser element detector returns DOM evidence; use the element selector for browser clicks.

## Branches and missing values

The inspector and validation warn when a reference may be unavailable on the current branch. For example, a value produced only on a condition's true branch may be missing after the branches rejoin. An error connection can also bypass a node's successful result.

These warnings do not insert fallback values or rewire the graph. Move the consuming node onto a path where its source succeeds, or assign an appropriate value on every incoming path. Optional output properties, such as a detector's matched rectangle, may still be absent even when the node runs.

Deleting a source node leaves the reference visible so it can be repaired. Validation rejects a reference to a missing node before execution. Renaming a variable or an input changes its lookup key; update its consumers as part of that change.

## Loop inputs

A Loop can iterate a count or use an array in **Items (optional)**. Use **Child inputs** to map values into each child call. `${item}` and `${index}` are available only in that mapping; the child reads them as `${inputs.item}` and `${inputs.index}`.

Remove the optional items value to return to count-based iteration. The configured safety limit still bounds the number of child invocations.
