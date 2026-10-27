{
  description = "A durable local German writing coach for Pi sessions";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";

  outputs = {
    self,
    nixpkgs,
    ...
  }: let
    systems = ["aarch64-darwin" "x86_64-darwin" "aarch64-linux" "x86_64-linux"];
    forAllSystems = nixpkgs.lib.genAttrs systems;
  in {
    packages = forAllSystems (system: let
      pkgs = import nixpkgs {inherit system;};
    in {
      default = pkgs.callPackage ./default.nix {};
    });

    checks = forAllSystems (system: {
      german-language-coach = self.packages.${system}.default;
    });
  };
}
