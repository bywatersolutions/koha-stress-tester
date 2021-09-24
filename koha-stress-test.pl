#!/usr/bin/perl

use Modern::Perl;

use Data::Dumper;
use File::Basename;
use Getopt::Long::Descriptive;
use HTTP::Request::Common;
use JSON::XS;
use LWP::UserAgent;
use List::Util qw(sum);
use Parallel::ForkManager;
use Text::ASCIITable;
use Time::HiRes qw( gettimeofday );
use Try::Tiny;
use WWW::Mechanize::Timed;

my ( $opt, $usage ) = describe_options(
    'koha-stress-test.pl %o ',
    [
        'staff-url|su=s',
        "The Koha staff URL to connect to",
        {
            required => 1,
            default  => $ENV{KOHA_INTRANET_URL} // 'http://127.0.0.1:8081'
        }
    ],
    [
        'opac-url|ou=s',
        "The Koha staff URL to connect to",
        {
            required => 1,
            default  => $ENV{KOHA_OPAC_URL} // 'http://127.0.0.1:8080'
        }
    ],
    [
        'username|u=s',
        "Koha username to use",
        { required => 1, default => $ENV{USERNAME} // 'koha' }
    ],
    [
        'password|p=s',
        "Password for Koha username",
        { required => 1, default => $ENV{PASSWORD} // 'koha' }
    ],
    [],
    [
        'checkouts|c=i',
        "Simultaneous virtual librarians checking out and checking in",
        { default => $ENV{CHECKOUTS} // 0 }
    ],
    [
        'checkouts-count|cc=i',
        "Number of checkouts each virtual librarian will process",
        { default => $ENV{CHECKOUTS_COUNT} // 0 }
    ],
    [],
    [
        'opac-searches|os=i',
        "Simultaneous public catalog searchs",
        { default => $ENV{OPAC_SEARCHES} // 0 }
    ],
    [
        'opac-searches-count|osc=i',
        "Number of searches each virtual patron will perform",
        { default => $ENV{CHECKOUTS_COUNT} // 0 }
    ],
    [],
    [
        'min-delay|min=i',
        "Minimum delay between actions",
        { default => $ENV{MIN_DELAY} // 1 }
    ],
    [
        'max-delay|max=i',
        "Maximum delay between actions",
        { default => $ENV{MAX_DELAY} // 3 }
    ],
    [],
    [
        "sip-checkouts|sc=s",
        "Simultaneous virtual librarians checking in/out via SIP"
    ],
    [
        "sip-checkouts-count|scc=s",
        "Number of checkouts each virtual librarian will process via SIP"
    ],
    [ "sip-cli-emulator-path|scep=s", "path to sip_cli_emulator.pl" ],
    [ "sip-host|sh=s",                "SIP host" ],
    [ "sip-port|sp=s",                "SIP port" ],
    [ "sip-user|sun=s",               "SIP username" ],
    [ "sip-pass|spw=s",               "SIP passwrd" ],
    [ "sip-loc|sl=s",                 "SIP location code" ],
    [ "sip-term|st=s",                "SIP terminator" ],
    [],
    [ 'verbose|v+', "print extra stuff", { default => 0 } ],
    [ 'help|h',     "print usage message and exit", { shortcircuit => 1 } ],
);

print( $usage->text ), exit if $opt->help;

my $ua      = LWP::UserAgent->new();
my $request = GET $opt->staff_url . "/api/v1/libraries";

$request->authorization_basic( $opt->username, $opt->password );
my $response = $ua->request($request);
if ( $response->code() eq "401" ) {
    say
"Access to Koha REST API via Basic Auth is disabled. Please enable RESTBasicAuth.";
    exit;
}
my $libraries = decode_json( $response->decoded_content() );

my $pm = Parallel::ForkManager->new(999);

# data structure retrieval and handling
my @responses;
$pm->run_on_finish(
    sub {
        my ( $pid, $exit_code, $ident, $exit_signal, $core_dump, $data ) = @_;

        # see what the child sent us, if anything
        if ( defined($data) ) {    # test rather than assume child sent anything
            push( @responses, $data );
        }
    }
);

say "OPAC SEARCHES: " . $opt->opac_searches             if $opt->verbose;
say "OPAC SEARCHES COUNT: " . $opt->opac_searches_count if $opt->verbose;
run_opac_searches( $opt, $pm ) if $opt->opac_searches > 0;

say "CHECKOUTS: " . $opt->checkouts             if $opt->verbose;
say "CHECKOUTS COUNT: " . $opt->checkouts_count if $opt->verbose;
run_checkouts( $opt, $pm )                      if $opt->checkouts > 0;

say "SIP CHECKOUTS: " . $opt->sip_checkouts             if $opt->verbose;
say "SIP CHECKOUTS COUNT: " . $opt->sip_checkouts_count if $opt->verbose;
run_sip_checkouts( $opt, $pm ) if $opt->sip_checkouts > 0;

sub run_opac_searches {
    my ( $opt, $pm ) = @_;

    my @search_keys = "a" .. "z";    ## TODO Add dictionary file?

    # run the parallel processes
  OPAC_SEARCHES:
    foreach my $opac_searches_counter ( 1 .. $opt->opac_searches ) {
        $pm->start() and next OPAC_SEARCHES;
        srand;
        my $data = {};

        my $agent = WWW::Mechanize::Timed->new( autocheck => 1 );

        my @pages;

        foreach my $opac_search ( 1 .. $opt->opac_searches_count ) {
            my $term = $search_keys[ rand @search_keys ];
            say
"STARTING SEARCH $opac_search FOR OPAC SEARCHER $opac_searches_counter USING SEARCH TERM '$term' IN OPAC"
              if $opt->verbose;

            $agent->get( $opt->opac_url );
            $agent->form_name('searchform');
            $agent->field( 'q',   $term );
            $agent->field( 'idx', '' );
            $agent->click();

            push(
                @pages,
                {
                    type                => 'search_results',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay;

            for my $i ( 1 .. 10 ) {
                my $last = 0;

                try {
                    say "CHECKING SEARCH RESULT $i FOR '$term' IN OPAC"
                      if $opt->verbose;

                    $agent->follow_link( n => $i, class => 'title' );
                    push(
                        @pages,
                        {
                            type                => 'result_details',
                            client_total_time   => $agent->client_total_time,
                            client_elapsed_time => $agent->client_elapsed_time
                        }
                    );
                    $agent->back;

                    sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
                      if $opt->min_delay && $opt->max_delay;
                }
                catch {
                    $last = 1;
                };

                last
                  if $last
                  ;    ## Supresses warning that shows if last is in catch block
            }
        }

        # send it back to the parent process
        $pm->finish( 0, { type => 'opac_search', pages => \@pages } );
    }
}

sub run_checkouts {
    my ( $opt, $pm ) = @_;

    my $ua = LWP::UserAgent->new();

    ## For now, each librarian will check out all items to one patron each
    my $patrons_count = $opt->checkouts;
    my $request =
      GET $opt->staff_url . "/api/v1/patrons?_per_page=$patrons_count";
    $request->authorization_basic( $opt->username, $opt->password );
    my $response = $ua->request($request);
    my $patrons  = decode_json( $response->decoded_content() );

    my $items_count = $opt->checkouts_count * $opt->checkouts;
    $request = GET $opt->staff_url . "/api/v1/items?_per_page=$items_count";
    $request->authorization_basic( $opt->username, $opt->password );
    $response = $ua->request($request);
    my $items_json = decode_json( $response->decoded_content() );
    my @items;
    push( @items, [ splice @$items_json, 0, $opt->checkouts_count ] )
      while @$items_json;

    # run the parallel processes
  CHECKOUTS_LOOP:
    foreach my $checkouts_counter ( 1 .. $opt->checkouts ) {
        $pm->start() and next CHECKOUTS_LOOP;
        srand;

        my $patron       = $patrons->[ $checkouts_counter - 1 ];
        my $items_to_use = $items[ $checkouts_counter - 1 ];

        my $cardnumber = $patron->{cardnumber};

        my $data = {};

        my $agent = WWW::Mechanize::Timed->new( autocheck => 1 );

        my @pages;

        my $branch = $libraries->[0]->{library_id};

        $agent->get( $opt->staff_url . "/cgi-bin/koha/mainpage.pl" );
        $agent->form_name('loginform');
        $agent->field( 'password', $opt->password );
        $agent->field( 'userid',   $opt->username );
        $agent->field( 'branch',   $branch );
        $agent->click( '', 'login to staff interface' );

        # Checkin code duplicated below
        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};
            say "CHECKING IN $barcode" if $opt->verbose;
            $agent->get( $opt->staff_url . "/cgi-bin/koha/circ/returns.pl" );
            $agent->form_id('checkin-form');
            $agent->field( 'barcode', $barcode );
            $agent->click( '', 'Check in' );

            push(
                @pages,
                {
                    type                => 'checkin',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        $agent->get( $opt->staff_url . "/cgi-bin/koha/circ/circulation.pl" );
        $agent->form_id('patronsearch');
        $agent->field( 'findborrower', $cardnumber );
        $agent->click( '', 'Submit' );

        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};

            say "CHECKING OUT $barcode TO $cardnumber" if $opt->verbose;

            $agent->form_id('mainform');
            $agent->field( 'barcode', $barcode );
            $agent->click( '', 'Check out' );

            push(
                @pages,
                {
                    type                => 'checkout',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        # Checkin code duplicated above
        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};
            say "CHECKING IN $barcode" if $opt->verbose;
            $agent->get( $opt->staff_url . "/cgi-bin/koha/circ/returns.pl" );
            $agent->form_id('checkin-form');
            $agent->field( 'barcode', $barcode );
            $agent->click( '', 'Check in' );

            push(
                @pages,
                {
                    type                => 'checkin',
                    client_total_time   => $agent->client_total_time,
                    client_elapsed_time => $agent->client_elapsed_time
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        # send it back to the parent process
        $pm->finish( 0, { type => 'circulation', pages => \@pages } );
    }
}

sub run_sip_checkouts {
    my ( $opt, $pm ) = @_;

    my $ua = LWP::UserAgent->new();

    ## For now, each librarian will check out all items to one patron each
    ## If we are doing regular checkouts to, let's use different patrons
    say "FETCHING PATRONS" if $opt->verbose;
    my $patrons_page  = $opt->checkouts ? $opt->checkouts + 1 : 1;
    my $patrons_count = $opt->sip_checkouts;
    my $request =
      GET $opt->staff_url
      . "/api/v1/patrons?_per_page=$patrons_count&_page=$patrons_page";
    $request->authorization_basic( $opt->username, $opt->password );
    my $response = $ua->request($request);
    my $patrons  = decode_json( $response->decoded_content() );
    say "RETRIEVED: " . @$patrons . " PATRONS" if $opt->verbose;

# Note: this is not quite accurate, as we are specifying SIP checkouts number indepently from web based checkouts
# But it should get us a set of items that are not shared by both processes
# We should really get all the items ( and patrons ) using one API call then parcel them out to each subroutineu
    say "FETCHING ITEMS" if $opt->verbose;
    my $items_page = $opt->checkouts_count
      && $opt->checkouts ? $opt->checkouts_checkouts * $opt->checkouts + 1 : 1;
    my $items_count = $opt->sip_checkouts_count * $opt->sip_checkouts;
    $request = GET $opt->staff_url
      . "/api/v1/items?_per_page=$items_count&_page=$items_page";
    $request->authorization_basic( $opt->username, $opt->password );
    $response = $ua->request($request);
    my $items_json = decode_json( $response->decoded_content() );
    say "RETRIEVED: " . @$items_json . " ITEMS" if $opt->verbose;
    my @items;
    push( @items, [ splice @$items_json, 0, $opt->sip_checkouts_count ] )
      while @$items_json;

    # run the parallel processes
  SIP_CHECKOUTS:
    foreach my $checkouts_counter ( 1 .. $opt->sip_checkouts ) {
        $pm->start() and next SIP_CHECKOUTS;
        srand;

        my $sip_cli_emulator_path = $opt->sip_cli_emulator_path;
        my $sip_host              = $opt->sip_host;
        my $sip_port              = $opt->sip_port;
        my $sip_user              = $opt->sip_user;
        my $sip_pass              = $opt->sip_pass;
        my $sip_loc               = $opt->sip_loc;
        my $sip_term              = $opt->sip_term;

        my $patron       = $patrons->[ $checkouts_counter - 1 ];
        my $items_to_use = $items[ $checkouts_counter - 1 ];

        my $cardnumber = $patron->{cardnumber};

        my $perl5lib = dirname($sip_cli_emulator_path) . '/..';
        say "SIP CLI EMULATOR PATH: $sip_cli_emulator_path" if $opt->verbose >= 4;;
        say "PERL5LIB: $perl5lib" if $opt->verbose >= 4;

        my $base_cmd =
qq{PERL5LIB=$perl5lib $sip_cli_emulator_path -a $sip_host -p $sip_port -su $sip_user -sp $sip_pass -l $sip_loc -t $sip_term --hold-mode +};
        my $checkin_cmd = qq{$base_cmd -m checkin --item};
        my $checkout_cmd =
          qq{$base_cmd -m checkout --patron $cardnumber --item};

        my $data = {};

        my @pages;

        # Checkin code duplicated below
        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};

            say "CHECKING IN $barcode VIA SIP" if $opt->verbose;
            say "$checkin_cmd $barcode"        if $opt->verbose >= 2;
            my $start_time     = gettimeofday();
            my $output         = `$checkin_cmd $barcode`;
            say "NO RESPONSE" unless $output;
            my $end_time       = gettimeofday();
            my $execution_time = $end_time - $start_time;
            say $output if $opt->verbose >= 1;

            push(
                @pages,
                {
                    type              => 'sip_checkin',
                    client_total_time => $execution_time,
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};

            say "CHECKING OUT $barcode TO $cardnumber VIA SIP" if $opt->verbose;
            say "$checkout_cmd $barcode" if $opt->verbose >= 2;
            my $start_time     = gettimeofday();
            my $output         = `$checkout_cmd $barcode`;
            say "NO RESPONSE" unless $output;
            my $end_time       = gettimeofday();
            my $execution_time = $end_time - $start_time;
            say $output if $opt->verbose >= 1;

            push(
                @pages,
                {
                    type              => 'sip_checkout',
                    client_total_time => $execution_time,
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        # Checkin code duplicated above
        foreach my $item (@$items_to_use) {
            my $barcode = $item->{external_id};

            say "CHECKING IN $barcode VIA SIP" if $opt->verbose;
            say "$checkin_cmd $barcode"        if $opt->verbose >= 2;
            my $start_time     = gettimeofday();
            my $output         = `$checkin_cmd $barcode`;
            say "NO RESPONSE" unless $output;
            my $end_time       = gettimeofday();
            my $execution_time = $end_time - $start_time;
            say $output if $opt->verbose >= 1;

            push(
                @pages,
                {
                    type              => 'sip_checkin',
                    client_total_time => $execution_time,
                }
            );

            sleep int( rand( $opt->max_delay ) ) + $opt->min_delay
              if $opt->min_delay && $opt->max_delay;
        }

        # send it back to the parent process
        $pm->finish( 0, { type => 'sip_circulation', pages => \@pages } );
    }
}

$pm->wait_all_children;

my $results = {
    opac_search_results_client_total_times   => [],
    opac_search_results_client_elapsed_times => [],
    opac_search_details_client_total_times   => [],
    opac_search_details_client_elapsed_times => [],
    checkin_client_elapsed_times             => [],
    checkin_client_total_times               => [],
    checkout_client_elapsed_times            => [],
    checkout_client_total_times              => [],
    sip_checkin_client_total_times           => [],
    sip_checkout_client_total_times          => [],
};

foreach my $r (@responses) {
    if ( $r->{type} eq 'opac_search' ) {
        my $pages = $r->{pages};

        foreach my $p (@$pages) {
            push(
                @{ $results->{opac_search_results_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'search_results';
            push(
                @{ $results->{opac_search_results_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'search_results';
            push(
                @{ $results->{opac_search_details_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'result_details';
            push(
                @{ $results->{opac_search_details_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'result_details';
        }
    }
    elsif ( $r->{type} eq 'circulation' ) {
        my $pages = $r->{pages};

        foreach my $p (@$pages) {
            push(
                @{ $results->{checkin_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'checkin';
            push(
                @{ $results->{checkin_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'checkin';
            push(
                @{ $results->{checkout_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'checkout';
            push(
                @{ $results->{checkout_client_elapsed_times} },
                $p->{client_elapsed_time}
            ) if $p->{type} eq 'checkout';
        }

    }
    elsif ( $r->{type} eq 'sip_circulation' ) {
        my $pages = $r->{pages};

        foreach my $p (@$pages) {
            push(
                @{ $results->{sip_checkin_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'sip_checkin';
            push(
                @{ $results->{sip_checkout_client_total_times} },
                $p->{client_total_time}
            ) if $p->{type} eq 'sip_checkout';
        }

    }
}

my $t = Text::ASCIITable->new( { headingText => 'Results' } );
$t->setCols( 'Type', 'Page loads', 'Average time (seconds)' );
foreach my $key ( sort keys %$results ) {
    my $times = $results->{$key};
    my $count = scalar @$times;
    next unless $count;
    my $average = sprintf( "%.3f", sum(@$times) / $count );
    $t->addRow( $key, $count, $average );
}
print $t;
