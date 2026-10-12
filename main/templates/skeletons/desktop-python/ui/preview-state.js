/* Bind preview readiness to current inputs and request generation. Business writes
 * still validate their own snapshot in Python; this helper controls only UI state. */
window.createPreviewGuard = function (inputs, executeButton) {
  var generation = 0, ready = null;
  function snapshot() { return JSON.stringify(inputs.map(function (input) { return input.value; })); }
  function invalidate() { generation += 1; ready = null; executeButton.disabled = true; }
  inputs.forEach(function (input) {
    input.addEventListener('input', invalidate);
    input.addEventListener('change', invalidate);
  });
  invalidate();
  return {
    invalidate: invalidate,
    begin: function () { invalidate(); return { generation: generation, inputs: snapshot() }; },
    accept: function (ticket, plan) {
      if (!ticket || ticket.generation !== generation || ticket.inputs !== snapshot()) return false;
      if (!plan || !Array.isArray(plan.rows) || !plan.rows.length) { invalidate(); return false; }
      ready = { inputs: ticket.inputs, plan: plan };
      executeButton.disabled = false;
      return true;
    },
    take: function () {
      if (!ready || ready.inputs !== snapshot()) { invalidate(); return null; }
      var plan = ready.plan;
      invalidate(); // consume once before awaiting the API, preventing duplicate execution
      return plan;
    }
  };
};
