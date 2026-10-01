# generic-go fixture

A small Go service with one feature flag, `new-checkout`, used to test the
generic adapter: discovery (`flagrm list`) and `verify`.

- `before/`: the flag is live. It is declared as a const (`flags.NewCheckout`),
  evaluated through the const in an `if`/`else`-shaped early return and through
  the literal in a guard, configured in `config/flags.yaml`, mentioned in a
  comment, and forced ON and OFF by two tests.
- `after/`: the golden removal. The const, the config entry, the OFF path
  (`placeOrderLegacy`), the comment and the OFF test are gone; the ON test
  keeps its assertions without the flag setup.
