import { Controller, Get, Text } from "@malagu/mvc/lib/node";

@Controller()
export class HomeController {
  @Get("/12")
  @Text()
  home(): string {
    console.log(222);

    return "Welcome to Malagu";
  }
}
