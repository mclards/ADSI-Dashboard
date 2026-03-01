from ADSI_ForecastService import main, parse_cli_args, run_cli_generation


if __name__ == "__main__":
    args = parse_cli_args()
    code = run_cli_generation(args)
    if code >= 0:
        raise SystemExit(code)
    main()
